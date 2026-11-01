import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { point as turfPoint, polygon as turfPolygon } from '@turf/helpers';

import {
  annotateManeuversWithZones,
  cumulativeDistances,
  planDetourWaypoints,
  PLANNER_CLEARANCES,
  nearestZonesToSegment,
  suggestViaPoints,
  toBoundingBoxZone,
  verifyRouteAgainstZones,
  zonesNearCorridor,
} from '../common/geo';
import { maxDeviationMeters, type AvoidZone } from '../common/geo';
import { collectVoiceKeys, finaliseManeuvers, type DraftManeuver } from '../common/maneuver';
import { PrismaService } from '../db/prisma.service';
import { DangerZonesService } from '../zones/danger-zones.service';
import { ZonesService } from '../zones/zones.service';
import { bakedZoneHash } from './baked-profiles';
import { LanesService } from './lanes.service';
import { ProviderRegistry } from './providers/provider-registry';
import { RouteComputeStatsService } from './route-compute-stats.service';
import type {
  ProviderRouteRequest,
  ProviderRouteResponse,
  RoutingProvider,
} from './providers/routing-provider';
import type {
  GeoJsonPolygon,
  LatLng,
  RoutePlan,
  RouteRequest,
  RouteResult,
  Stringency,
} from '@shared';

/**
 * We evaluate a handful of candidate via points rather than one, because the geometrically
 * cheapest one often sits on the wrong side of the road network and produces an absurd
 * detour. Each candidate costs one provider call.
 */
const MAX_VIA_ATTEMPTS = 6;

/**
 * How many of those candidates are tried concurrently. They are independent guesses, so a wave
 * costs one round trip instead of one per candidate; keeping the wave well under the total
 * budget means a lucky first wave still ends the search without paying for the rest.
 */
const VIA_WAVE_SIZE = 3;

/**
 * A clean route no longer than this multiple of the naive route is accepted immediately;
 * remaining candidates are then not worth their provider calls.
 */
const ACCEPTABLE_DETOUR_RATIO = 1.4;

/**
 * How many waves of candidates may be sent, each one re-ranked after discovering that a detour
 * traded one forbidden zone for another. MAX_VIA_ATTEMPTS is the binding limit in practice;
 * this is the belt-and-braces bound so a pathological area cannot spin.
 */
const MAX_FALLBACK_ROUNDS = 4;

/**
 * How many native alternatives to request. Deliberately generous: providers return fewer
 * alternatives once avoid areas constrain the search (HERE collapses to a single route at
 * alternatives=2 but yields three at 6), so we ask for a wide pool, verify each, drop the
 * near-identical ones, and keep the best MAX_PLAN_ROUTES. One provider call returns them all.
 */
const WANTED_ALTERNATIVES = 6;

/** Most routes to return in a plan. */
const MAX_PLAN_ROUTES = 3;

/**
 * Most obstacle zones handed to the visibility-graph detour planner. The planner is roughly
 * cubic in this count, so it is capped to the nearest few; the full corridor set still governs
 * verification, so capping never lets an unclean route through.
 */
const MAX_PLANNER_ZONES = 12;

/**
 * Two routes closer than this everywhere are the same corridor. Used to drop near-identical
 * alternatives so the plan offers genuinely different choices.
 */
const DEDUP_DEVIATION_METERS = 80;

/** Identity for the "already tried" set, at roughly 10 m resolution. */
function viaKey(via: LatLng): string {
  return `${via.lat.toFixed(4)},${via.lng.toFixed(4)}`;
}

@Injectable()
export class RoutingService {
  private readonly logger = new Logger(RoutingService.name);
  /** Per in-flight request, the baked profile its zone set maps to (see bakedZonesFor). */
  private readonly bakedZonesByRequest = new WeakMap<RouteRequest, ProviderRouteRequest['bakedZones']>();
  private readonly bakedHashCache = new Map<
    Stringency,
    { zones: AvoidZone[]; danger: AvoidZone[]; hash: string }
  >();

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly zones: ZonesService,
    private readonly dangerZones: DangerZonesService,
    private readonly prisma: PrismaService,
    private readonly stats: RouteComputeStatsService,
    private readonly lanes: LanesService,
  ) {}

  /**
   * Computes a plan and stores every route in it by id, so a navigation session can reference
   * a chosen route (or the reroute default) by id.
   */
  async computeAndStorePlan(request: RouteRequest, userId: string | null): Promise<RoutePlan> {
    // Time only the route computation itself (provider calls + verification), not the storage
    // loop. Recording is best-effort and only lands a row under the compute interceptor.
    const startedAt = Date.now();
    const plan = await this.computePlan(request);
    const computeMs = Date.now() - startedAt;

    const best = plan.routes[0];
    this.stats.record({
      provider: best?.engine ?? request.engine ?? 'unknown',
      engine: request.engine ?? best?.engine ?? 'default',
      computeMs,
      alternativeCount: plan.routes.length,
      verifiedClean: best?.verifiedClean ?? false,
      stringency: request.stringency,
      mode: request.mode,
      originLat: request.origin.lat,
      originLng: request.origin.lng,
      destLat: request.destination.lat,
      destLng: request.destination.lng,
      distanceMeters: best?.distanceMeters ?? null,
      durationSeconds: best?.durationSeconds ?? null,
      avoidDangerZones: request.avoidDangerZones !== false,
      avoidTolls: request.avoidTolls ?? false,
      routeId: best?.id ?? null,
      userId,
    });

    // One id for the whole plan. It is what lets the admin console answer "which alternatives
    // did the system offer here, and which one did the driver navigate", instead of inferring
    // the sibling routes from identical request payloads.
    const planId = randomUUID();
    const toStore: { route: RouteResult; role: string }[] = [
      ...plan.routes.map((route, index) => ({
        route,
        role: index === 0 ? 'primary' : 'alternative',
      })),
      ...(plan.unavoidedRoute ? [{ route: plan.unavoidedRoute, role: 'unavoided' }] : []),
    ];
    // Written in one statement rather than a row at a time: these are independent inserts, and
    // each result blob carries a full route geometry, so serialising them put four avoidable
    // round trips on the request path after the compute was already done.
    await this.prisma.route.createMany({
      data: toStore.map((entry, index) => ({
        id: entry.route.id,
        userId,
        planId,
        role: entry.role,
        rank: index,
        request: request as unknown as object,
        result: entry.route as unknown as object,
      })),
    });
    return plan;
  }

  /**
   * Produces up to three zone-verified alternatives (best first, labeled), honouring toll
   * avoidance, plus the unavoided route for comparison when asked and when avoidance actually
   * changed the outcome. Every returned route is independently verified against the zones; the
   * geometry is never trusted on the provider's word.
   */
  async computePlan(request: RouteRequest): Promise<RoutePlan> {
    const attempts: string[] = [];
    const provider = this.registry.get(request.engine);
    const stringencyZones = await this.zones.getZones(request.stringency);

    // Danger zones (Area A) are avoided by default, on their own axis, in addition to the
    // halachic stringency zones. Both share verification and annotation as AvoidZone.
    const avoidDanger = request.avoidDangerZones !== false;
    const dangerZones = avoidDanger ? await this.dangerZones.getAvoidZones() : [];
    this.bakedZonesByRequest.set(
      request,
      this.bakedZonesFor(request, stringencyZones as AvoidZone[], dangerZones),
    );

    // Only zones near the origin-destination corridor can affect this route. With hundreds of
    // real zones nationwide, filtering to the corridor is what keeps verification, the provider
    // avoid list, and the detour planner fast and correct - a distant zone cannot be crossed.
    const zones: AvoidZone[] = zonesNearCorridor(
      [...stringencyZones, ...dangerZones],
      request.origin,
      request.destination,
    );
    const polygons = zones.map((zone) => zone.geometry);
    attempts.push(
      `provider=${provider.name} nativeAvoidance=${provider.supportsNativeAvoidance} ` +
        `stringencyZones=${stringencyZones.length} dangerZones=${dangerZones.length} ` +
        `nearCorridor=${zones.length} avoidTolls=${Boolean(request.avoidTolls)}`,
    );

    // Fail fast and fail safe: if an endpoint sits inside a zone no route can ever be clean.
    // The test is pure geometry, so it runs before any upstream call rather than after one.
    const blockedEndpoint = this.endpointInsideZone(request, zones);
    if (blockedEndpoint) {
      const plain = { ...this.base(request), avoidAreas: [], via: [] };
      const naive = await this.tryCompute(provider, plain, attempts, 'naive');
      const route = naive ?? (await provider.computeRoute(plain));
      const [priced] = await this.priceForPlan(provider, [route], request, polygons, attempts);
      return {
        routes: [
          this.result(
            request,
            provider,
            priced,
            naive,
            false,
            `endpoint_inside_zone:${blockedEndpoint}`,
            attempts,
            zones,
          ),
        ],
      };
    }

    // (0) + (1) The naive baseline (which powers the debug overlay, the detour ratio and the
    //     unavoided comparison) and the native avoid-the-polygons candidates are independent
    //     requests, so they go out together: one round trip for both instead of two.
    const [naive, rawCandidates] = await Promise.all([
      this.tryCompute(
        provider,
        { ...this.base(request), avoidAreas: [], via: [] },
        attempts,
        'naive',
      ),
      this.tryComputeMany(
        provider,
        { ...this.base(request), avoidAreas: polygons, via: [], alternatives: WANTED_ALTERNATIVES },
        attempts,
        'native',
      ),
    ]);

    const cleanCandidates: ProviderRouteResponse[] = [];
    rawCandidates.forEach((candidate, index) => {
      if (candidate.note) attempts.push(`native candidate ${index} note: ${candidate.note}`);
      const check = verifyRouteAgainstZones(candidate.geometry, zones);
      attempts.push(
        `native candidate ${index}: clean=${check.clean} distance=${candidate.distanceMeters}m` +
          (check.clean
            ? ''
            : ` offending=[${check.offending.map((z) => z.properties.name).join(', ')}]`),
      );
      if (check.clean) cleanCandidates.push(candidate);
    });

    let cleanRoutes = this.dedupeCandidates(cleanCandidates);

    // (2) If native avoidance produced nothing clean, run the heuristic detour search for one
    //     clean route. This is the guarantee path for engines that cannot block polygons.
    if (cleanRoutes.length === 0) {
      // The planner is roughly cubic in obstacle vertex count, so it gets only the nearest few
      // zones, each simplified to its bounding box. Verification inside the heuristic still uses
      // the full corridor set, so this never lets an unclean route through.
      const plannerZones = nearestZonesToSegment(
        zones,
        request.origin,
        request.destination,
        MAX_PLANNER_ZONES,
      ).map(toBoundingBoxZone);
      const heuristic = await this.findCleanByHeuristic(
        request,
        provider,
        zones,
        plannerZones,
        polygons,
        naive,
        attempts,
      );
      if (heuristic) cleanRoutes = [heuristic];
    }

    // (3) Choose what the plan returns - still unpriced.
    //
    //     Every clean candidate is kept for pricing, and the cut to MAX_PLAN_ROUTES happens
    //     after it, on the priced time. Cutting first on the shape engine's own time looks
    //     tempting but is wrong: that time is traffic-dependent, so the same request in
    //     free-flow and in live-traffic mode would keep different candidates and could return
    //     different geometry for the same route. The set is bounded by WANTED_ALTERNATIVES, and
    //     pricing is concurrent, so keeping all of it costs no extra round trip.
    const clean = cleanRoutes.length > 0;
    const chosen: ProviderRouteResponse[] = [];
    if (clean) {
      chosen.push(...cleanRoutes);
    } else {
      // Fail safe: never pad with an unclean alternative. Return the single unclean attempt,
      // flagged unusable, so the client can show "no clean route" and nav refuses it.
      this.logger.warn(
        `Failing safe: no clean route for ${JSON.stringify(request.origin)} to ` +
          `${JSON.stringify(request.destination)} at stringency=${request.stringency}`,
      );
      const fallback = rawCandidates[0] ?? naive;
      if (fallback) chosen.push(fallback);
    }

    // (4) The unavoided route, for side-by-side comparison, only when it was asked for AND
    //     avoidance actually changed the outcome (the plain route crosses a zone).
    const toPrice = [...chosen];
    let naiveIndex = -1;
    if (request.includeUnavoided && naive && !verifyRouteAgainstZones(naive.geometry, zones).clean) {
      // The fail-safe route above can BE the naive one; then it is priced once and reused.
      naiveIndex = toPrice.indexOf(naive);
      if (naiveIndex === -1) naiveIndex = toPrice.push(naive) - 1;
    }

    // (5) The only pricing round trip of the whole compute. Everything above was decided on
    //     clean geometry and distance, so no discarded candidate ever cost a Google call.
    const priced = await this.priceForPlan(provider, toPrice, request, polygons, attempts);
    // Lane guidance needs the routes' OSM way ids, so it is added to the final routes only.
    await this.lanes.annotate(priced);

    const built = priced
      .slice(0, chosen.length)
      .map((route) =>
        this.result(
          request,
          provider,
          route,
          naive,
          clean,
          clean ? undefined : 'avoidance_failed',
          attempts,
          zones,
        ),
      );
    const routes = clean ? this.labelAndOrder(built).slice(0, MAX_PLAN_ROUTES) : built;

    const unavoidedRoute =
      naiveIndex === -1
        ? undefined
        : this.result(
            request,
            provider,
            priced[naiveIndex],
            naive,
            false,
            'unavoided_comparison',
            attempts,
            zones,
            { label: 'unavoided' },
          );

    return { routes, ...(unavoidedRoute ? { unavoidedRoute } : {}) };
  }

  /**
   * Fills in the travel time for the routes the plan actually returns, when the provider gets
   * its shape and its time from different engines. One concurrent round trip for the whole
   * plan, however many routes it holds.
   *
   * Never throws and never drops a route: a provider without the split, or an unreachable
   * pricing engine, yields the routes exactly as they came in, carrying the shape engine's own
   * time. A missing ETA must not be able to fail a compute that already found a clean route.
   */
  private async priceForPlan(
    provider: RoutingProvider,
    routes: ProviderRouteResponse[],
    request: RouteRequest,
    polygons: GeoJsonPolygon[],
    attempts: string[],
  ): Promise<ProviderRouteResponse[]> {
    if (!provider.priceRoutes || routes.length === 0) return routes;
    try {
      const priced = await provider.priceRoutes(routes, {
        ...this.base(request),
        avoidAreas: polygons,
        via: [],
      });
      priced.forEach((route, index) => {
        if (route.note) attempts.push(`priced route ${index}: ${route.note}`);
      });
      return priced;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      attempts.push(`pricing failed: ${message}; keeping the shape engine's times`);
      this.logger.warn(`pricing failed: ${message}`);
      return routes;
    }
  }

  /**
   * Heuristic detour search: the visibility-graph planner then a ring of candidate via points,
   * keeping the SHORTEST clean result. Returns one clean route or null. Extracted so the plan
   * flow uses it only when native avoidance yields nothing clean.
   */
  private async findCleanByHeuristic(
    request: RouteRequest,
    provider: RoutingProvider,
    zones: AvoidZone[],
    plannerZones: AvoidZone[],
    polygons: GeoJsonPolygon[],
    naive: ProviderRouteResponse | null,
    attempts: string[],
  ): Promise<ProviderRouteResponse | null> {
    let best: { route: ProviderRouteResponse; via: LatLng } | undefined;
    const referenceDistance = naive?.distanceMeters ?? Number.POSITIVE_INFINITY;

    // Plan the whole detour first: one routing call through a chain of waypoints that threads
    // between the zones. The obstacle graph uses only the nearest zones (bounded cost); the
    // result is still verified against the full corridor set below.
    //
    // Planning itself is local, so every clearance level is planned up front and the routing
    // calls go out together: one round trip instead of one per level. The tightest clean level
    // still wins, exactly as it did when the levels were tried in turn.
    const plans: { level: number; waypoints: LatLng[] }[] = [];
    for (const [level, clearance] of PLANNER_CLEARANCES.entries()) {
      const planned = planDetourWaypoints(
        request.origin,
        request.destination,
        plannerZones,
        8,
        clearance,
      );
      if (planned === null) {
        attempts.push(`detour plan L${level + 1}: no zone-free chain exists at this clearance`);
        continue;
      }
      // An empty chain means there is nothing to thread around at this clearance. A wider one
      // would only detour further for no reason, so the plan search stops here.
      if (planned.length === 0) break;
      plans.push({ level, waypoints: planned });
    }

    const planLabel = (plan: { level: number; waypoints: LatLng[] }) =>
      `detour plan L${plan.level + 1} (${plan.waypoints.length} waypoint(s))`;

    const plannedRoutes = await Promise.all(
      plans.map((plan) =>
        this.tryCompute(
          provider,
          { ...this.base(request), avoidAreas: polygons, via: plan.waypoints },
          attempts,
          planLabel(plan),
        ),
      ),
    );

    for (const [index, planRoute] of plannedRoutes.entries()) {
      if (!planRoute) continue;
      const plan = plans[index];
      const planCheck = verifyRouteAgainstZones(planRoute.geometry, zones);
      attempts.push(
        `${planLabel(plan)} gave clean=${planCheck.clean} distance=${planRoute.distanceMeters}m` +
          (planCheck.clean
            ? ''
            : ` offending=[${planCheck.offending.map((z) => z.properties.name).join(', ')}]`),
      );
      if (planCheck.clean) {
        best = { route: planRoute, via: plan.waypoints[0] };
        break;
      }
    }

    const firstOffending = verifyRouteAgainstZones(
      naive?.geometry ?? { type: 'LineString', coordinates: [] },
      zones,
    ).offending;
    const blocking: AvoidZone[] = [...firstOffending];
    const tried = new Set<string>();
    let budget =
      best && best.route.distanceMeters <= referenceDistance * ACCEPTABLE_DETOUR_RATIO
        ? 0
        : MAX_VIA_ATTEMPTS;

    for (let round = 1; round <= MAX_FALLBACK_ROUNDS && budget > 0; round++) {
      // Ranked against the full attempt budget, not the remaining one: asking for only as many
      // as are left would keep returning the same top few, which are already tried, and the
      // search would starve itself before it had spent its budget.
      const candidates = suggestViaPoints(
        request.origin,
        request.destination,
        blocking,
        plannerZones,
        MAX_VIA_ATTEMPTS,
      ).filter((via) => !tried.has(viaKey(via)));

      if (candidates.length === 0) break;
      attempts.push(
        `fallback round ${round}: ${candidates.length} candidate(s) around ` +
          `[${blocking.map((z) => z.properties.name).join(', ')}]`,
      );

      // Candidates go out in waves rather than one at a time or all at once. One at a time cost
      // up to six sequential round trips; all at once always paid for six calls even when the
      // first guess was the good one. A wave is the middle: the calls inside it are concurrent,
      // and a wave that already found a short enough detour means the rest are never made.
      const batch = candidates.slice(0, Math.min(VIA_WAVE_SIZE, budget));
      batch.forEach((via) => tried.add(viaKey(via)));
      budget -= batch.length;

      const retries = await Promise.all(
        batch.map((via) =>
          this.tryCompute(
            provider,
            { ...this.base(request), avoidAreas: polygons, via: [via] },
            attempts,
            `via ${via.lat.toFixed(5)},${via.lng.toFixed(5)}`,
          ),
        ),
      );

      for (const [index, retry] of retries.entries()) {
        if (!retry) continue;
        const via = batch[index];
        const label = `via ${via.lat.toFixed(5)},${via.lng.toFixed(5)}`;

        const retryCheck = verifyRouteAgainstZones(retry.geometry, zones);
        attempts.push(
          `${label} gave clean=${retryCheck.clean} distance=${retry.distanceMeters}m` +
            (retryCheck.clean
              ? ''
              : ` offending=[${retryCheck.offending
                  .map((z) => z.properties.name)
                  .join(', ')}]`),
        );

        if (!retryCheck.clean) {
          // Every zone this attempt hit joins the blocking set, which is what re-ranks the
          // candidates for the next wave.
          for (const zone of retryCheck.offending) {
            if (!blocking.some((known) => known.properties.id === zone.properties.id)) {
              blocking.push(zone);
            }
          }
          continue;
        }

        if (!best || retry.distanceMeters < best.route.distanceMeters) {
          best = { route: retry, via };
        }
      }

      // A short enough detour ends the search: a further wave can only find a longer one, and
      // this is what keeps the common case at one wave rather than the whole budget.
      if (best && best.route.distanceMeters <= referenceDistance * ACCEPTABLE_DETOUR_RATIO) {
        attempts.push('fallback: detour is short enough, stopping the search');
        break;
      }
    }

    if (best) {
      attempts.push(
        `fallback: chose ${best.via.lat.toFixed(5)},${best.via.lng.toFixed(5)} ` +
          `(${best.route.distanceMeters}m vs naive ${referenceDistance}m)`,
      );
      return best.route;
    }
    return null;
  }

  /** Drops near-identical candidates so the plan offers genuinely different corridors. */
  private dedupeCandidates(candidates: ProviderRouteResponse[]): ProviderRouteResponse[] {
    const kept: ProviderRouteResponse[] = [];
    for (const candidate of candidates) {
      const duplicate = kept.some(
        (other) =>
          maxDeviationMeters(other.geometry, candidate.geometry, DEDUP_DEVIATION_METERS) <
            DEDUP_DEVIATION_METERS &&
          maxDeviationMeters(candidate.geometry, other.geometry, DEDUP_DEVIATION_METERS) <
            DEDUP_DEVIATION_METERS,
      );
      if (!duplicate) kept.push(candidate);
    }
    return kept;
  }

  /**
   * Orders the routes fastest first and labels them: the quickest is "fastest", the shortest
   * by distance (when different) is "shortest", the rest "alt".
   */
  private labelAndOrder(routes: RouteResult[]): RouteResult[] {
    const ordered = [...routes].sort((a, b) => a.durationSeconds - b.durationSeconds);
    if (ordered.length === 0) return ordered;

    let shortestIndex = 0;
    ordered.forEach((route, index) => {
      if (route.distanceMeters < ordered[shortestIndex].distanceMeters) shortestIndex = index;
    });

    return ordered.map((route, index) => ({
      ...route,
      label:
        index === 0 ? 'fastest' : index === shortestIndex ? 'shortest' : 'alt',
    }));
  }

  private base(
    request: RouteRequest,
  ): Omit<ProviderRouteRequest, 'avoidAreas' | 'via' | 'alternatives'> {
    const bakedZones = this.bakedZonesByRequest.get(request);
    return {
      origin: request.origin,
      destination: request.destination,
      mode: request.mode,
      trafficAware: request.trafficAware,
      language: request.language ?? 'he',
      avoidTolls: request.avoidTolls ?? false,
      ...(bakedZones ? { bakedZones } : {}),
    };
  }

  /**
   * The baked-zone profile matching this request's FULL zone set - the stringency zones plus
   * the danger zones, in the order the services return them, exactly as
   * scripts/export-graph-models.ts exports them for the graph build. Only driving with danger
   * zones avoided has a baked profile. The hash is cached per loaded zone list: the services
   * hand back the same array until the data changes.
   */
  private bakedZonesFor(
    request: RouteRequest,
    stringencyZones: AvoidZone[],
    dangerZones: AvoidZone[],
  ): ProviderRouteRequest['bakedZones'] {
    if (request.mode !== 'drive' || request.avoidDangerZones === false) return undefined;
    const cached = this.bakedHashCache.get(request.stringency);
    if (cached && cached.zones === stringencyZones && cached.danger === dangerZones) {
      return { stringency: request.stringency, hash: cached.hash };
    }
    const hash = bakedZoneHash([
      ...stringencyZones.map((zone) => zone.geometry),
      ...dangerZones.map((zone) => zone.geometry),
    ]);
    this.bakedHashCache.set(request.stringency, { zones: stringencyZones, danger: dangerZones, hash });
    return { stringency: request.stringency, hash };
  }

  private endpointInsideZone(request: RouteRequest, zones: AvoidZone[]): string | null {
    for (const [label, coord] of [
      ['origin', request.origin],
      ['destination', request.destination],
    ] as const) {
      const inside = zones.find((zone) =>
        booleanPointInPolygon(
          turfPoint([coord.lng, coord.lat]),
          turfPolygon(zone.geometry.coordinates),
        ),
      );
      if (inside) return label;
    }
    return null;
  }

  /** Non-fatal variant: a failed side computation must not sink the whole request. */
  private async tryCompute(
    provider: RoutingProvider,
    request: ProviderRouteRequest,
    attempts: string[],
    label: string,
  ): Promise<ProviderRouteResponse | null> {
    try {
      return await provider.computeRoute(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      attempts.push(`${label} attempt failed: ${message}`);
      this.logger.warn(`${label} attempt failed: ${message}`);
      return null;
    }
  }

  /**
   * Primary plus native alternatives. Uses the provider's `computeRoutes` when it offers one,
   * otherwise a single `computeRoute`. Never throws: an upstream failure yields an empty list
   * and the caller falls back to the heuristic.
   */
  private async tryComputeMany(
    provider: RoutingProvider,
    request: ProviderRouteRequest,
    attempts: string[],
    label: string,
  ): Promise<ProviderRouteResponse[]> {
    try {
      if (provider.computeRoutes) return await provider.computeRoutes(request);
      const single = await provider.computeRoute(request);
      return [single];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      attempts.push(`${label} attempt failed: ${message}`);
      this.logger.warn(`${label} attempt failed: ${message}`);
      return [];
    }
  }

  private result(
    request: RouteRequest,
    provider: RoutingProvider,
    route: ProviderRouteResponse,
    naive: ProviderRouteResponse | null,
    verifiedClean: boolean,
    reason: string | undefined,
    attempts: string[],
    zones: AvoidZone[],
    options: { label?: string } = {},
  ): RouteResult {
    const id = randomUUID();
    const drafts = this.normaliseDrafts(route);
    // Zone warnings belong in the turn list itself, not only in a banner (spec section 8.1).
    const annotated = annotateManeuversWithZones(route.geometry, drafts, zones);
    const maneuvers = finaliseManeuvers(id, annotated, cumulativeDistances(route.geometry));

    const detourRatio =
      naive && naive.distanceMeters > 0
        ? Math.round((route.distanceMeters / naive.distanceMeters) * 100) / 100
        : undefined;

    // Only providers that can express toll avoidance mark a route as toll-free; the mock
    // engine cannot, so it never claims to.
    const avoidsTolls = Boolean(request.avoidTolls) && provider.name !== 'mock';

    return {
      id,
      geometry: route.geometry,
      maneuvers,
      distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds,
      verifiedClean,
      reason,
      attribution: provider.attribution,
      engine: provider.name as RouteResult['engine'],
      ...(avoidsTolls ? { avoidsTolls: true } : {}),
      ...(options.label ? { label: options.label } : {}),
      detourRatio,
      requiredVoiceKeys: collectVoiceKeys(maneuvers),
      ...(route.speedLimits ? { speedLimits: route.speedLimits } : {}),
      debug: {
        naiveGeometry: naive?.geometry,
        attempts,
        naiveDistanceMeters: naive?.distanceMeters,
      },
    };
  }

  /**
   * Providers disagree on how they label the first and last step. Forcing them makes the
   * icon and the voice clip identical whichever engine served the request.
   */
  private normaliseDrafts(route: ProviderRouteResponse): DraftManeuver[] {
    const drafts = route.maneuvers
      .slice()
      .sort((a, b) => a.geometryIndex - b.geometryIndex)
      .map((draft) => ({ ...draft }));

    if (drafts.length === 0) return drafts;
    drafts[0].action = 'depart';
    drafts[0].geometryIndex = 0;
    drafts[drafts.length - 1].action = 'arrive';
    drafts[drafts.length - 1].geometryIndex = route.geometry.coordinates.length - 1;
    return drafts;
  }
}
