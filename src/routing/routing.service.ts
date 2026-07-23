import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { point as turfPoint, polygon as turfPolygon } from '@turf/helpers';

import {
  annotateManeuversWithZones,
  cumulativeDistances,
  planDetourWaypoints,
  PLANNER_CLEARANCES,
  suggestViaPoints,
  verifyRouteAgainstZones,
} from '../common/geo';
import { collectVoiceKeys, finaliseManeuvers, type DraftManeuver } from '../common/maneuver';
import { PrismaService } from '../db/prisma.service';
import { ZonesService } from '../zones/zones.service';
import { ProviderRegistry } from './providers/provider-registry';
import type {
  ProviderRouteRequest,
  ProviderRouteResponse,
  RoutingProvider,
} from './providers/routing-provider';
import type { LatLng, RouteRequest, RouteResult, ZoneFeature } from '@shared';

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
    private readonly prisma: PrismaService,
  ) {}

  /** Computes a route and stores it, so a navigation session can reference it by id. */
  async computeAndStore(request: RouteRequest, userId: string | null): Promise<RouteResult> {
    const result = await this.compute(request);
    await this.prisma.route.create({
      data: {
        id: result.id,
        userId,
        request: request as unknown as object,
        result: result as unknown as object,
      },
    });
    return result;
  }

  async compute(request: RouteRequest): Promise<RouteResult> {
    const attempts: string[] = [];
    const provider = this.registry.get(request.engine);
    const zones = await this.zones.getZones(request.stringency);
    const polygons = zones.map((zone) => zone.geometry);
    attempts.push(
      `provider=${provider.name} nativeAvoidance=${provider.supportsNativeAvoidance} ` +
        `zones=${zones.length}`,
    );

    // (0) Naive baseline with avoidance off. Powers the debug overlay and proves the demo
    //     data is meaningful, that is, a route that would naturally cross a zone.
    const naive = await this.tryCompute(
      provider,
      { ...this.base(request), avoidAreas: [], via: [] },
      attempts,
      'naive',
    );

    // Fail fast and fail safe: if an endpoint sits inside a zone no route can ever be clean.
    const blockedEndpoint = this.endpointInsideZone(request, zones);
    if (blockedEndpoint) {
      return this.result(
        request,
        provider,
        naive ??
          (await provider.computeRoute({ ...this.base(request), avoidAreas: [], via: [] })),
        naive,
        false,
        `endpoint_inside_zone:${blockedEndpoint}`,
        attempts,
        zones,
      );
    }

    // (1) Primary attempt - ask the provider to avoid the polygons natively.
    let candidate = await provider.computeRoute({
      ...this.base(request),
      avoidAreas: polygons,
      via: [],
    });
    if (candidate.note) attempts.push(`provider note: ${candidate.note}`);
    let check = verifyRouteAgainstZones(candidate.geometry, zones);
    attempts.push(
      `avoid-areas attempt: clean=${check.clean}` +
        (check.clean
          ? ''
          : ` offending=[${check.offending.map((z) => z.properties.name).join(', ')}]`),
    );

    // (2) Heuristic fallback - route through a detour waypoint drawn from a ring around the
    //     offending zone, and keep the SHORTEST clean result rather than the first one.
    const referenceDistance = naive?.distanceMeters ?? candidate.distanceMeters;

    if (!check.clean) {
      let best: { route: ProviderRouteResponse; via: LatLng } | undefined;

      // (2a) Plan the whole detour first: one routing call through a chain of waypoints that
      //      threads between the zones. Clearance widens on each failure - a provider that
      //      cuts a tight corner back into a zone usually respects a wider corridor.
      for (const [level, clearance] of PLANNER_CLEARANCES.entries()) {
        const planned = planDetourWaypoints(
          request.origin,
          request.destination,
          zones,
          8,
          clearance,
        );
        if (planned === null) {
          attempts.push(
            `detour plan L${level + 1}: no zone-free chain exists at this clearance`,
          );
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
              : ` offending=[${planCheck.offending
                  .map((z) => z.properties.name)
                  .join(', ')}]`),
        );
        if (planCheck.clean) {
          best = { route: planRoute, via: planned[0] };
          break;
        }
      }

      // Zones known to block us. A retry often trades one zone for another, so this grows as
      // we learn, and the candidate ring is rebuilt around everything that blocks.
      const blocking: ZoneFeature[] = [...check.offending];
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
          zones,
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
            // A newly discovered blocker invalidates the rest of this round's shortlist.
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
        candidate = best.route;
        check = { clean: true, offending: [] };
        attempts.push(
          `fallback: chose ${best.via.lat.toFixed(5)},${best.via.lng.toFixed(5)} ` +
            `(${best.route.distanceMeters}m vs naive ${referenceDistance}m)`,
        );
      }
      // No clean candidate: `candidate` stays the provider's own avoid-areas attempt, which
      // is returned flagged as unusable rather than silently presented as safe.
    }

    if (!check.clean) {
      this.logger.warn(
        `Failing safe: no clean route for ${JSON.stringify(request.origin)} to ` +
          `${JSON.stringify(request.destination)} at stringency=${request.stringency}`,
      );
    }

    return this.result(
      request,
      provider,
      candidate,
      naive,
      check.clean,
      check.clean ? undefined : 'avoidance_failed',
      attempts,
      zones,
    );
  }

  private base(request: RouteRequest): Omit<ProviderRouteRequest, 'avoidAreas' | 'via'> {
    return {
      origin: request.origin,
      destination: request.destination,
      mode: request.mode,
      trafficAware: request.trafficAware,
      language: request.language ?? 'he',
    };
  }

  private endpointInsideZone(request: RouteRequest, zones: ZoneFeature[]): string | null {
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

  private result(
    request: RouteRequest,
    provider: RoutingProvider,
    route: ProviderRouteResponse,
    naive: ProviderRouteResponse | null,
    verifiedClean: boolean,
    reason: string | undefined,
    attempts: string[],
    zones: ZoneFeature[],
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
