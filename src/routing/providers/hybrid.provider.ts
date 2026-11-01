import { Injectable, Logger } from "@nestjs/common";

import {
  intersectsAnyPolygon,
  maxDeviationMeters,
  sampleWaypoints,
} from "../../common/geo";
import { config } from "../../config";
import { GoogleProvider } from "./google.provider";
import {
  GraphHopperProvider,
  GraphHopperUnavailableError,
} from "./graphhopper.provider";
import { HereProvider } from "./here.provider";
import type {
  ProviderRouteRequest,
  ProviderRouteResponse,
  RoutingProvider,
} from "./routing-provider";

/**
 * Google is pinned to the shape with waypoints spaced roughly every kilometre, not a fixed
 * count. This matters: too many waypoints in a corridor Google disagrees with forces it to
 * loop between the pinned points (measured: 25 waypoints on the taharat preset tripled the
 * distance), while roughly one per kilometre lets it follow real roads while still tracking
 * the corridor. Capped at Google's 25-intermediate limit; longer routes therefore get denser
 * absolute pinning, which is what they need.
 */
const PRICING_WAYPOINT_SPACING_METERS = 1200;
const MIN_PRICING_WAYPOINTS = 3;
const MAX_PRICING_WAYPOINTS = 25;

/**
 * The gate is a "different route" detector, NOT a precision check. Time is an ETA, not a
 * safety property - the safety property is the zone-clean geometry, which is always the shape
 * engine's and always verified. So Google's duration is kept for ordinary snapping wobble and
 * for a corridor Google weaves along, and rejected only on a gross mismatch:
 *   - the priced path strays beyond a few hundred meters, scaled to route length, OR
 *   - Google's total distance is more than 60% off the shape, i.e. a genuinely other route.
 * A 240 m wobble, or a corridor Google follows within a few hundred meters while weaving onto
 * adjacent streets, is not a different route and its time is kept.
 */
const GROSS_DEVIATION_FLOOR_METERS = 800;
const GROSS_DEVIATION_RATIO = 0.25;
const MAX_DISTANCE_MISMATCH_RATIO = 0.6;

/**
 * Separation of concerns (spec section 6.7): shape from an engine that blocks polygons inside
 * its own graph search, travel time ALWAYS from Google priced over that shape - in both
 * traffic modes.
 *
 *  - trafficAware=false  -> Google TRAFFIC_UNAWARE (free-flow) duration
 *  - trafficAware=true   -> Google TRAFFIC_AWARE (live traffic) duration
 *
 * The two differ whenever traffic differs, and the user always sees a Google ETA.
 *
 * Pricing is a SECOND phase, not part of the shape call: `computeRoute`/`computeRoutes` hand
 * back the shape engine's route untouched, and RoutingService calls `priceRoutes` once, on the
 * routes it has settled on. The search itself picks candidates purely on clean geometry and
 * distance, so pricing a candidate before it was chosen only ever bought a Google call for a
 * route about to be discarded. On a plan that falls through to the detour search that was over
 * half of the upstream calls, all of them on the critical path.
 *
 * Safety rules that make this honest rather than convenient:
 *  - the geometry returned is ALWAYS the shape engine's, never Google's;
 *  - a shape that still touches a zone is never priced (RoutingService verifies the final
 *    geometry regardless, and such a route is flagged unusable anyway);
 *  - the shape engine's own time is used only as a last-resort fallback (Google unreachable,
 *    or a gross route mismatch), and the note says so.
 */
@Injectable()
export class HybridProvider implements RoutingProvider {
  readonly name = "hybrid";
  readonly supportsNativeAvoidance = true;
  readonly supportsLiveTraffic = true;

  private readonly logger = new Logger(HybridProvider.name);

  constructor(
    private readonly graphhopper: GraphHopperProvider,
    private readonly here: HereProvider,
    private readonly google: GoogleProvider,
  ) {}

  get attribution(): string {
    return `${this.shape.attribution} - travel times by Google`;
  }

  /** The engine that decides the route. Must be one that blocks polygons natively. */
  private get shape(): RoutingProvider {
    return config.hybridShapeEngine === "here" ? this.here : this.graphhopper;
  }

  /** The shape only. The ETA arrives later, through `priceRoutes`. */
  async computeRoute(
    request: ProviderRouteRequest,
  ): Promise<ProviderRouteResponse> {
    const [route] = await this.withBackupEngine((engine) =>
      engine.computeRoute(request).then((r) => [r]),
    );
    return route;
  }

  /** Every alternative shape comes from the polygon-blocking engine, unpriced. */
  async computeRoutes(
    request: ProviderRouteRequest,
  ): Promise<ProviderRouteResponse[]> {
    return this.withBackupEngine((engine) =>
      engine.computeRoutes
        ? engine.computeRoutes(request)
        : engine.computeRoute(request).then((r) => [r]),
    );
  }

  /**
   * Runs a shape call on the configured engine. When that is the self-hosted GraphHopper and it
   * is not serving (first graph build after a deploy, the restart during a nightly graph swap),
   * the call is answered by HERE instead, if a HERE key is configured. HERE also blocks the
   * zones natively, and RoutingService verifies the result against the zones either way, so
   * the backup changes speed and attribution, never safety. A real routing failure ("no route")
   * is not retried.
   */
  private async withBackupEngine(
    call: (engine: RoutingProvider) => Promise<ProviderRouteResponse[]>,
  ): Promise<ProviderRouteResponse[]> {
    const engine = this.shape;
    try {
      return await call(engine);
    } catch (error) {
      if (
        engine !== this.graphhopper ||
        !(error instanceof GraphHopperUnavailableError) ||
        !config.hereApiKey
      ) {
        throw error;
      }
      this.logger.warn(`${error.message}; answering this route from HERE`);
      const routes = await call(this.here);
      const attribution = `${this.here.attribution} - travel times by Google`;
      return routes.map((route) => ({ ...route, attribution }));
    }
  }

  /**
   * Prices the routes the plan actually returns. They go to Google concurrently: this is one
   * round trip for the whole plan, however many routes it holds.
   */
  async priceRoutes(
    routes: ProviderRouteResponse[],
    request: ProviderRouteRequest,
  ): Promise<ProviderRouteResponse[]> {
    return Promise.all(routes.map((route) => this.priceShape(route, request)));
  }

  private async priceShape(
    base: ProviderRouteResponse,
    request: ProviderRouteRequest,
  ): Promise<ProviderRouteResponse> {
    const mode = request.trafficAware ? "TRAFFIC_AWARE" : "TRAFFIC_UNAWARE";

    // Never price a shape that still touches a zone: that candidate is about to be discarded.
    if (intersectsAnyPolygon(base.geometry, request.avoidAreas)) {
      return {
        ...base,
        note: "traffic pricing skipped: this shape still touches a zone",
      };
    }

    const count = Math.min(
      MAX_PRICING_WAYPOINTS,
      Math.max(
        MIN_PRICING_WAYPOINTS,
        Math.round(base.distanceMeters / PRICING_WAYPOINT_SPACING_METERS),
      ),
    );
    const waypoints = sampleWaypoints(base.geometry, count);
    if (waypoints.length === 0) {
      return {
        ...base,
        note: "traffic pricing skipped: route too short to pin waypoints",
      };
    }

    try {
      // trafficAware is passed through unchanged, so Google prices free-flow or live traffic
      // exactly as asked. avoidAreas is empty: the shape already encodes the avoidance.
      const priced = await this.google.computeRoute({
        ...request,
        via: waypoints,
        avoidAreas: [],
      });

      const deviation = maxDeviationMeters(base.geometry, priced.geometry);
      const deviationAllowance = Math.max(
        GROSS_DEVIATION_FLOOR_METERS,
        base.distanceMeters * GROSS_DEVIATION_RATIO,
      );
      const distanceMismatch =
        base.distanceMeters > 0
          ? Math.abs(priced.distanceMeters - base.distanceMeters) /
            base.distanceMeters
          : 0;

      const grossMismatch =
        deviation > deviationAllowance ||
        distanceMismatch > MAX_DISTANCE_MISMATCH_RATIO;

      if (grossMismatch) {
        const note =
          `traffic pricing rejected (${mode}): Google took a different route ` +
          `(deviation ${Math.round(deviation)} m > ${Math.round(deviationAllowance)} m, or ` +
          `distance off by ${(distanceMismatch * 100).toFixed(0)}% > ` +
          `${MAX_DISTANCE_MISMATCH_RATIO * 100}%); using ${this.shape.name} free-flow time`;
        this.logger.warn(note);
        return { ...base, note };
      }

      return {
        ...base,
        durationSeconds: priced.durationSeconds,
        note:
          `traffic priced by Google (${mode}, deviation ${Math.round(deviation)} m, ` +
          `distance off ${(distanceMismatch * 100).toFixed(0)}%, ` +
          `${this.shape.name} ${base.durationSeconds}s to Google ${priced.durationSeconds}s)`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ...base,
        note: `traffic pricing unavailable (${mode}, ${message}); ${this.shape.name} time`,
      };
    }
  }
}
