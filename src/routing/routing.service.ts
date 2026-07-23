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
import { ProviderRegistry } from './providers/provider-registry';
import type {
  ProviderRouteRequest,
  ProviderRouteResponse,
  RoutingProvider,
} from './providers/routing-provider';
import type { GeoJsonPolygon, LatLng, RoutePlan, RouteRequest, RouteResult } from '@shared';

/**
 * We evaluate a handful of candidate via points rather than one, because the geometrically
 * cheapest one often sits on the wrong side of the road network and produces an absurd
 * detour. Each candidate costs one provider call.
 */
const MAX_VIA_ATTEMPTS = 6;

/**
 * A clean route no longer than this multiple of the naive route is accepted immediately;
 * remaining candidates are then not worth their provider calls.
 */
const ACCEPTABLE_DETOUR_RATIO = 1.4;

/**
 * How many times the candidate ring may be rebuilt after discovering that a detour traded
 * one forbidden zone for another. Bounded so a pathological area cannot spin.
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

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly zones: ZonesService,
    private readonly dangerZones: DangerZonesService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Computes a plan and stores every route in it by id, so a navigation session can reference
   * a chosen route (or the reroute default) by id.
   */
  async computeAndStorePlan(request: RouteRequest, userId: string | null): Promise<RoutePlan> {
    const plan = await this.computePlan(request);
    const toStore = [...plan.routes, ...(plan.unavoidedRoute ? [plan.unavoidedRoute] : [])];
    for (const route of toStore) {
      await this.prisma.route.create({
        data: {
          id: route.id,
          userId,
          request: request as unknown as object,
          result: route as unknown as object,
        },
      });
    }
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

    // (0) Naive baseline with avoidance off. Powers the debug overlay, the detour ratio, and
    //     the unavoided comparison route.
    const naive = await this.tryCompute(
      provider,
      { ...this.base(request), avoidAreas: [], via: [] },
      attempts,
      'naive',
    );

    // Fail fast and fail safe: if an endpoint sits inside a zone no route can ever be clean.
    const blockedEndpoint = this.endpointInsideZone(request, zones);
    if (blockedEndpoint) {
      const route =
        naive ??
        (await provider.computeRoute({ ...this.base(request), avoidAreas: [], via: [] }));
      return {
        routes: [
          this.result(
            request,
            provider,
            route,
            naive,
            false,
            `endpoint_inside_zone:${blockedEndpoint}`,
            attempts,
            zones,
          ),
        ],
      };
    }

    // (1) Native candidates - ask the provider to avoid the polygons AND return alternatives.
    const rawCandidates = await this.tryComputeMany(
      provider,
      { ...this.base(request), avoidAreas: polygons, via: [], alternatives: WANTED_ALTERNATIVES },
      attempts,
      'native',
    );

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

    // (3) Assemble the plan.
    let routes: RouteResult[];
    if (cleanRoutes.length > 0) {
      const built = cleanRoutes.map((route) =>
        this.result(request, provider, route, naive, true, undefined, attempts, zones),
      );
      routes = this.labelAndOrder(built).slice(0, MAX_PLAN_ROUTES);
    } else {
      // Fail safe: never pad with an unclean alternative. Return the single unclean attempt,
      // flagged unusable, so the client can show "no clean route" and nav refuses it.
      this.logger.warn(
        `Failing safe: no clean route for ${JSON.stringify(request.origin)} to ` +
          `${JSON.stringify(request.destination)} at stringency=${request.stringency}`,
      );
      const fallback = rawCandidates[0] ?? naive;
      routes = fallback
        ? [
            this.result(
              request,
              provider,
              fallback,
              naive,
              false,
              'avoidance_failed',
              attempts,
              zones,
            ),
          ]
        : [];
    }

    // (4) The unavoided route, for side-by-side comparison, only when it was asked for AND
    //     avoidance actually changed the outcome (the plain route crosses a zone).
    let unavoidedRoute: RouteResult | undefined;
    if (request.includeUnavoided && naive) {
      const naiveCheck = verifyRouteAgainstZones(naive.geometry, zones);
      if (!naiveCheck.clean) {
        unavoidedRoute = this.result(
          request,
          provider,
          naive,
          naive,
          false,
          'unavoided_comparison',
          attempts,
          zones,
          { label: 'unavoided' },
        );
      }
    }

    return { routes, ...(unavoidedRoute ? { unavoidedRoute } : {}) };
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
      if (planned.length === 0) break;

      const label = `detour plan L${level + 1} (${planned.length} waypoint(s))`;
      const planRoute = await this.tryCompute(
        provider,
        { ...this.base(request), avoidAreas: polygons, via: planned },
        attempts,
        label,
      );
      if (!planRoute) continue;

      const planCheck = verifyRouteAgainstZones(planRoute.geometry, zones);
      attempts.push(
        `${label} gave clean=${planCheck.clean} distance=${planRoute.distanceMeters}m` +
          (planCheck.clean
            ? ''
            : ` offending=[${planCheck.offending.map((z) => z.properties.name).join(', ')}]`),
      );
      if (planCheck.clean) {
        best = { route: planRoute, via: planned[0] };
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
      const candidates = suggestViaPoints(
        request.origin,
        request.destination,
        blocking,
        plannerZones,
        budget,
      ).filter((via) => !tried.has(viaKey(via)));

      if (candidates.length === 0) break;
      attempts.push(
        `fallback round ${round}: ${candidates.length} candidate(s) around ` +
          `[${blocking.map((z) => z.properties.name).join(', ')}]`,
      );

      let learnedSomething = false;

      for (const via of candidates) {
        if (budget <= 0) break;
        tried.add(viaKey(via));
        budget--;

        const label = `via ${via.lat.toFixed(5)},${via.lng.toFixed(5)}`;
        const retry = await this.tryCompute(
          provider,
          { ...this.base(request), avoidAreas: polygons, via: [via] },
          attempts,
          label,
        );
        if (!retry) continue;

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
          for (const zone of retryCheck.offending) {
            if (!blocking.some((known) => known.properties.id === zone.properties.id)) {
              blocking.push(zone);
              learnedSomething = true;
            }
          }
          if (learnedSomething) break;
          continue;
        }

        if (!best || retry.distanceMeters < best.route.distanceMeters) {
          best = { route: retry, via };
        }
        if (best.route.distanceMeters <= referenceDistance * ACCEPTABLE_DETOUR_RATIO) {
          attempts.push('fallback: detour is short enough, stopping the search');
          budget = 0;
          break;
        }
      }

      if (!learnedSomething) break;
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
          maxDeviationMeters(other.geometry, candidate.geometry) < DEDUP_DEVIATION_METERS &&
          maxDeviationMeters(candidate.geometry, other.geometry) < DEDUP_DEVIATION_METERS,
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
    return {
      origin: request.origin,
      destination: request.destination,
      mode: request.mode,
      trafficAware: request.trafficAware,
      language: request.language ?? 'he',
      avoidTolls: request.avoidTolls ?? false,
    };
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
