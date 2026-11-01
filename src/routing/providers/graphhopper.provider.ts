import { Injectable, Logger } from "@nestjs/common";

import type { DraftManeuver } from "../../common/maneuver";
import { config } from "../../config";
import {
  bakedProfileName,
  tollBlockingModel,
  zoneBlockingModel,
} from "../baked-profiles";
import {
  type PathDetail,
  toSpeedLimits,
  toWayIds,
} from "./graphhopper-details";
import type {
  ProviderRouteRequest,
  ProviderRouteResponse,
  RoutingProvider,
} from "./routing-provider";

interface GraphHopperInstruction {
  text?: string;
  sign?: number;
  street_name?: string;
  /** Road reference number, e.g. "1" or "443". */
  street_ref?: string;
  /** Roundabout exit to take (sign 6 only). */
  exit_number?: number;
  /** [firstPointIndex, lastPointIndex] into the path geometry. */
  interval?: [number, number];
}

interface GraphHopperPath {
  distance?: number;
  /** Milliseconds. */
  time?: number;
  points?: { type?: string; coordinates?: [number, number][] };
  instructions?: GraphHopperInstruction[];
  details?: Record<string, PathDetail<unknown>[]>;
}

interface GraphHopperResponse {
  paths?: GraphHopperPath[];
  message?: string;
  hints?: { message?: string }[];
}

interface GraphHopperInfo {
  profiles?: { name?: string }[];
  encoded_values?: Record<string, unknown>;
}

interface EngineInfo {
  profiles: Set<string>;
  encodedValues: Set<string>;
}

/** Path details requested for driving routes, when the graph was built with them. */
const DRIVE_DETAILS = [
  "max_speed",
  "max_speed_estimated",
  "urban_density",
  "osm_way_id",
];

/** How long the engine's profile list is trusted before it is fetched again. */
const INFO_TTL_MS = 60_000;

/** After a failed /info, how long before it is tried again. */
const INFO_RETRY_MS = 10_000;

/**
 * The engine could not be reached or is not serving a graph (connection refused, a gateway
 * error, a non-JSON reply). Distinct from "no route": the hybrid provider answers this one
 * from its backup engine, while a real routing failure is passed through untouched.
 */
export class GraphHopperUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphHopperUnavailableError";
  }
}

/** Statuses a container that is starting, restarting or swapping graphs answers with. */
const UNAVAILABLE_STATUSES = new Set([502, 503, 504]);

/**
 * GraphHopper provider - the only engine here whose avoidance we express ourselves, and the
 * only one where that expression happens inside the graph search.
 *
 * Two ways to avoid zones, chosen per request:
 *
 * - Baked: the graph was built with a profile whose custom model already blocks the request's
 *   exact zone set (see routing/baked-profiles.ts), with a toll-free variant of each. The
 *   request names that profile and nothing else, so it runs in speed mode (contraction
 *   hierarchies) like a plain route.
 * - Per request: the zone polygons travel in the request as a `custom_model` (packed areas with
 *   priority 0), which needs `ch.disable` and runs in hybrid mode on the plain car profile. Used whenever no matching baked profile is
 *   loaded (a graph built from older zones, danger zones switched off, or a fresh install).
 *
 * What it does not have is live traffic, which is surfaced through `supportsLiveTraffic`.
 */
@Injectable()
export class GraphHopperProvider implements RoutingProvider {
  readonly name = "graphhopper";
  readonly attribution =
    "Routing provided by GraphHopper, OpenStreetMap contributors";
  readonly supportsNativeAvoidance = true;
  readonly supportsLiveTraffic = false;

  private readonly logger = new Logger(GraphHopperProvider.name);
  private info: (EngineInfo & { expiresAt: number }) | null = null;
  private infoInFlight: Promise<void> | null = null;

  async computeRoute(
    request: ProviderRouteRequest,
  ): Promise<ProviderRouteResponse> {
    const routes = await this.computeRoutes({ ...request, alternatives: 0 });
    return routes[0];
  }

  async computeRoutes(
    request: ProviderRouteRequest,
  ): Promise<ProviderRouteResponse[]> {
    const url = new URL(config.graphHopperUrl);
    // A self-hosted instance needs no key.
    if (config.graphHopperApiKey)
      url.searchParams.set("key", config.graphHopperApiKey);

    const { body: requestBody, note } = await this.buildBody(request);
    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
    } catch (error) {
      throw new GraphHopperUnavailableError(
        `GraphHopper unreachable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const bodyText = await response.text();
    if (UNAVAILABLE_STATUSES.has(response.status)) {
      throw new GraphHopperUnavailableError(
        `GraphHopper unavailable (${response.status})`,
      );
    }
    let body: GraphHopperResponse;
    try {
      body = JSON.parse(bodyText) as GraphHopperResponse;
    } catch {
      throw new GraphHopperUnavailableError(
        `GraphHopper returned non-JSON response (${response.status}): ${bodyText.slice(0, 200)}`,
      );
    }

    if (!response.ok) {
      const detail = body.message ?? body.hints?.[0]?.message ?? bodyText;
      throw new Error(
        `GraphHopper routing failed (${response.status}): ${detail}`,
      );
    }

    const paths = (body.paths ?? []).filter(
      (path) => (path.points?.coordinates?.length ?? 0) >= 2,
    );
    if (paths.length === 0) {
      throw new Error("GraphHopper returned no route for this request");
    }

    return paths.map((path) => {
      const coordinates = path.points!.coordinates!;
      const details = path.details ?? {};
      const speedLimits = toSpeedLimits(
        details.max_speed as PathDetail<number | null>[] | undefined,
        details.max_speed_estimated as PathDetail<boolean | null>[] | undefined,
        details.urban_density as PathDetail<string | null>[] | undefined,
      );
      const wayIds = toWayIds(
        details.osm_way_id as PathDetail<number | null>[] | undefined,
      );
      return {
        geometry: { type: "LineString" as const, coordinates },
        maneuvers: this.toManeuvers(path, coordinates),
        distanceMeters: Math.round(path.distance ?? 0),
        durationSeconds: Math.round((path.time ?? 0) / 1000),
        ...(note ? { note } : {}),
        ...(speedLimits ? { speedLimits } : {}),
        ...(wayIds ? { wayIds } : {}),
      };
    });
  }

  /**
   * The profiles and encoded values the running engine was built with. Cached briefly: they
   * change only when a rebuilt graph is swapped in, and a stale answer is harmless - a profile
   * that vanished fails one request, a new one is picked up within a minute.
   */
  private async engineInfo(): Promise<EngineInfo> {
    if (this.info && Date.now() < this.info.expiresAt) return this.info;
    if (!this.infoInFlight) {
      this.infoInFlight = this.fetchInfo().finally(() => {
        this.infoInFlight = null;
      });
    }
    await this.infoInFlight;
    return this.info ?? { profiles: new Set(), encodedValues: new Set() };
  }

  private async fetchInfo(): Promise<void> {
    try {
      const url = new URL(config.graphHopperUrl);
      url.pathname = url.pathname.replace(/\/route\/?$/, "/info");
      if (config.graphHopperApiKey)
        url.searchParams.set("key", config.graphHopperApiKey);
      const response = await fetch(url.toString(), {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const info = (await response.json()) as GraphHopperInfo;
      this.info = {
        expiresAt: Date.now() + INFO_TTL_MS,
        profiles: new Set(
          (info.profiles ?? []).map((p) => p.name ?? "").filter(Boolean),
        ),
        encodedValues: new Set(Object.keys(info.encoded_values ?? {})),
      };
    } catch (error) {
      this.logger.warn(`GraphHopper /info failed: ${(error as Error).message}`);
      // Remember the failure briefly too, so an unreachable engine is not asked per request.
      this.info = {
        expiresAt: Date.now() + INFO_RETRY_MS,
        profiles: new Set(),
        encodedValues: new Set(),
      };
    }
  }

  private async buildBody(
    request: ProviderRouteRequest,
  ): Promise<{ body: Record<string, unknown>; note?: string }> {
    const {
      origin,
      destination,
      mode,
      via = [],
      avoidAreas,
      avoidTolls,
      language,
    } = request;
    const alternatives = request.alternatives ?? 0;
    const walking = mode === "walk";
    // Only a self-hosted engine can carry our profiles and encoded values.
    const info = config.graphHopperSelfHosted ? await this.engineInfo() : null;

    const points = [origin, ...via, destination].map((p) => [p.lng, p.lat]);

    const body: Record<string, unknown> = {
      profile: walking ? "foot" : "car",
      points,
      // GeoJSON out - no polyline decoding, no decoder bugs.
      points_encoded: false,
      instructions: true,
      locale: language,
      calc_points: true,
    };

    if (!walking && info) {
      // Asking for a detail the graph was not built with fails the whole request.
      const details = DRIVE_DETAILS.filter((key) =>
        info.encodedValues.has(key),
      );
      if (details.length > 0) body.details = details;
    }

    let note: string | undefined;
    const baked =
      !walking && avoidAreas.length > 0 && request.bakedZones
        ? bakedProfileName(
            request.bakedZones.stringency,
            request.bakedZones.hash,
            Boolean(avoidTolls),
          )
        : null;

    if (baked && info?.profiles.has(baked)) {
      // The zones (and, for the toll-free variant, the toll rule) are already in the graph: no
      // custom model at all, so the request runs in speed mode.
      body.profile = baked;
      note = `baked profile ${baked}`;
    } else {
      if (baked && info)
        note = `no baked profile ${baked} loaded; zones sent per request`;
      const needsCustomModel = avoidAreas.length > 0 || avoidTolls;
      if (needsCustomModel) {
        body["ch.disable"] = true; // custom models are only available in flexible/hybrid mode
        const zones = zoneBlockingModel(avoidAreas);
        body.custom_model = avoidTolls
          ? {
              ...zones,
              priority: [...zones.priority, ...tollBlockingModel().priority],
            }
          : zones;
      }
    }

    if (walking) {
      // Walking has no prepared graph: always the flexible mode.
      body["ch.disable"] = true;
      body["lm.disable"] = true;
    }

    // Alternatives need the plain two-point request; via points already pin the shape.
    // GraphHopper 11 computes alternatives with whichever solver the request selects (speed,
    // hybrid or flexible mode), so a custom model does not rule them out.
    if (alternatives > 0 && via.length === 0) {
      body.algorithm = "alternative_route";
      body["alternative_route.max_paths"] = Math.min(alternatives + 1, 4);
    }

    if (request.trafficAware) {
      this.logger.debug(
        "trafficAware requested but GraphHopper has no live traffic - free-flow times.",
      );
    }

    return { body, note };
  }

  private toManeuvers(
    path: GraphHopperPath,
    coordinates: [number, number][],
  ): DraftManeuver[] {
    const maneuvers: DraftManeuver[] = [];
    for (const instruction of path.instructions ?? []) {
      const index = instruction.interval?.[0] ?? 0;
      const point = coordinates[index];
      if (!point || !instruction.text) continue;
      maneuvers.push({
        instruction: instruction.text,
        action: signToAction(instruction.sign),
        point: { lat: point[1], lng: point[0] },
        geometryIndex: index,
        street: instruction.street_name || null,
        ...(instruction.street_ref ? { roadRef: instruction.street_ref } : {}),
        ...(instruction.sign === 6 && instruction.exit_number
          ? { exitNumber: instruction.exit_number }
          : {}),
      });
    }
    return maneuvers;
  }
}

/** GraphHopper encodes maneuvers as numeric signs; map them onto our stable action keys. */
function signToAction(sign?: number): string {
  switch (sign) {
    case -98:
      return "uturn";
    case -8:
      return "uturn";
    case -7:
      return "keep_left";
    case -3:
      return "sharp_left";
    case -2:
      return "turn_left";
    case -1:
      return "slight_left";
    case 0:
      return "continue";
    case 1:
      return "slight_right";
    case 2:
      return "turn_right";
    case 3:
      return "sharp_right";
    case 4:
      return "arrive";
    case 5:
      return "continue";
    case 6:
      return "roundabout_enter";
    case 7:
      return "keep_right";
    default:
      return "continue";
  }
}
