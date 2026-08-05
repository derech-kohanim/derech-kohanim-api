import { Injectable, Logger } from '@nestjs/common';

import type { DraftManeuver } from '../../common/maneuver';
import { config } from '../../config';
import type {
  ProviderRouteRequest,
  ProviderRouteResponse,
  RoutingProvider,
} from './routing-provider';
import type { GeoJsonPolygon } from '@shared';

interface GraphHopperInstruction {
  text?: string;
  sign?: number;
  street_name?: string;
  /** [firstPointIndex, lastPointIndex] into the path geometry. */
  interval?: [number, number];
}

interface GraphHopperPath {
  distance?: number;
  /** Milliseconds. */
  time?: number;
  points?: { type?: string; coordinates?: [number, number][] };
  instructions?: GraphHopperInstruction[];
}

interface GraphHopperResponse {
  paths?: GraphHopperPath[];
  message?: string;
  hints?: { message?: string }[];
}

/**
 * GraphHopper provider - the only engine here whose avoidance we express ourselves, and the
 * only one where that expression happens inside the graph search.
 *
 * The zone polygons are sent as a `custom_model`: each polygon becomes an entry in `areas`
 * and a `priority` rule multiplies it by 0, so the router cannot traverse those edges at
 * all. Custom models require the flexible mode, hence `ch.disable: true`.
 *
 * What it does not have is live traffic, which is surfaced through `supportsLiveTraffic`.
 */
@Injectable()
export class GraphHopperProvider implements RoutingProvider {
  readonly name = 'graphhopper';
  readonly attribution = 'Routing provided by GraphHopper, OpenStreetMap contributors';
  readonly supportsNativeAvoidance = true;
  readonly supportsLiveTraffic = false;

  private readonly logger = new Logger(GraphHopperProvider.name);

  async computeRoute(request: ProviderRouteRequest): Promise<ProviderRouteResponse> {
    const routes = await this.computeRoutes({ ...request, alternatives: 0 });
    return routes[0];
  }

  async computeRoutes(request: ProviderRouteRequest): Promise<ProviderRouteResponse[]> {
    const url = new URL(config.graphHopperUrl);
    // A self-hosted instance needs no key.
    if (config.graphHopperApiKey) url.searchParams.set('key', config.graphHopperApiKey);

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.buildBody(request)),
    });

    const bodyText = await response.text();
    let body: GraphHopperResponse;
    try {
      body = JSON.parse(bodyText) as GraphHopperResponse;
    } catch {
      throw new Error(
        `GraphHopper returned non-JSON response (${response.status}): ${bodyText}`,
      );
    }

    if (!response.ok) {
      const detail = body.message ?? body.hints?.[0]?.message ?? bodyText;
      throw new Error(`GraphHopper routing failed (${response.status}): ${detail}`);
    }

    const paths = (body.paths ?? []).filter(
      (path) => (path.points?.coordinates?.length ?? 0) >= 2,
    );
    if (paths.length === 0) {
      throw new Error('GraphHopper returned no route for this request');
    }

    return paths.map((path) => {
      const coordinates = path.points!.coordinates!;
      return {
        geometry: { type: 'LineString' as const, coordinates },
        maneuvers: this.toManeuvers(path, coordinates),
        distanceMeters: Math.round(path.distance ?? 0),
        durationSeconds: Math.round((path.time ?? 0) / 1000),
      };
    });
  }

  private buildBody(request: ProviderRouteRequest): Record<string, unknown> {
    const { origin, destination, mode, via = [], avoidAreas, avoidTolls, language } = request;
    const alternatives = request.alternatives ?? 0;

    const points = [origin, ...via, destination].map((p) => [p.lng, p.lat]);

    const body: Record<string, unknown> = {
      profile: mode === 'walk' ? 'foot' : 'car',
      points,
      // GeoJSON out - no polyline decoding, no decoder bugs.
      points_encoded: false,
      instructions: true,
      locale: language,
      calc_points: true,
    };

    const needsCustomModel = avoidAreas.length > 0 || avoidTolls;
    if (needsCustomModel) {
      body['ch.disable'] = true; // custom models are only available in flexible mode
      body.custom_model = this.buildCustomModel(avoidAreas, Boolean(avoidTolls));
    }

    // Alternatives need the plain two-point request; via points already pin the shape.
    //
    // Note what is NOT excluded here: a custom model. GraphHopper supports alternative routes
    // in every mode (speed mode uses a different algorithm from flexible and hybrid, but both
    // work), and skipping them whenever a custom model was present meant skipping them exactly
    // when zones are being avoided - which is every real request. This engine then returned a
    // single candidate where HERE returns several, so a shape that failed verification fell
    // straight through to the expensive detour search instead of trying the next alternative.
    if (alternatives > 0 && via.length === 0) {
      body.algorithm = 'alternative_route';
      body['alternative_route.max_paths'] = Math.min(alternatives + 1, 4);
    }

    if (request.trafficAware) {
      this.logger.debug(
        'trafficAware requested but GraphHopper has no live traffic - free-flow times.',
      );
    }

    return body;
  }

  /**
   * Zones become areas with priority 0 (impassable). When avoidTolls is set, toll roads are
   * multiplied by 0 too, using the `toll` encoded value the car profile carries.
   */
  private buildCustomModel(
    polygons: GeoJsonPolygon[],
    avoidTolls: boolean,
  ): Record<string, unknown> {
    const features = polygons.map((polygon, index) => ({
      type: 'Feature',
      id: `zone_${index}`,
      properties: {},
      geometry: { type: 'Polygon', coordinates: this.closedRing(polygon) },
    }));

    const priority: { if: string; multiply_by: string }[] = features.map((feature) => ({
      if: `in_${feature.id}`,
      multiply_by: '0',
    }));
    if (avoidTolls) {
      // The car profile carries a `toll` encoded value (NO/ALL/HGV); block the tolled ones.
      priority.push({ if: 'toll == ALL', multiply_by: '0' });
      priority.push({ if: 'toll == HGV', multiply_by: '0' });
    }

    return {
      priority,
      areas: { type: 'FeatureCollection', features },
    };
  }

  /** GraphHopper requires the ring to be explicitly closed. */
  private closedRing(polygon: GeoJsonPolygon): [number, number][][] {
    const ring = [...(polygon.coordinates[0] ?? [])];
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
      ring.push([first[0], first[1]]);
    }
    return [ring];
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
      });
    }
    return maneuvers;
  }
}

/** GraphHopper encodes maneuvers as numeric signs; map them onto our stable action keys. */
function signToAction(sign?: number): string {
  switch (sign) {
    case -98:
      return 'uturn';
    case -8:
      return 'uturn';
    case -7:
      return 'keep_left';
    case -3:
      return 'sharp_left';
    case -2:
      return 'turn_left';
    case -1:
      return 'slight_left';
    case 0:
      return 'continue';
    case 1:
      return 'slight_right';
    case 2:
      return 'turn_right';
    case 3:
      return 'sharp_right';
    case 4:
      return 'arrive';
    case 5:
      return 'continue';
    case 6:
      return 'roundabout_enter';
    case 7:
      return 'keep_right';
    default:
      return 'continue';
  }
}
