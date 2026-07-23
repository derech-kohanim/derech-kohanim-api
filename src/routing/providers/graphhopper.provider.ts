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

    const path = body.paths?.[0];
    const coordinates = path?.points?.coordinates;
    if (!path || !coordinates || coordinates.length < 2) {
      throw new Error('GraphHopper returned no route for this request');
    }

    return {
      geometry: { type: 'LineString', coordinates },
      maneuvers: this.toManeuvers(path, coordinates),
      distanceMeters: Math.round(path.distance ?? 0),
      durationSeconds: Math.round((path.time ?? 0) / 1000),
    };
  }

  private buildBody(request: ProviderRouteRequest): Record<string, unknown> {
    const { origin, destination, mode, via = [], avoidAreas, language } = request;

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

    if (avoidAreas.length > 0) {
      body['ch.disable'] = true; // custom models are only available in flexible mode
      body.custom_model = this.buildCustomModel(avoidAreas);
    }

    if (request.trafficAware) {
      this.logger.debug(
        'trafficAware requested but GraphHopper has no live traffic - free-flow times.',
      );
    }

    return body;
  }

  /** Each zone becomes an area with priority 0, that is, impassable. */
  private buildCustomModel(polygons: GeoJsonPolygon[]): Record<string, unknown> {
    const features = polygons.map((polygon, index) => ({
      type: 'Feature',
      id: `zone_${index}`,
      properties: {},
      geometry: { type: 'Polygon', coordinates: this.closedRing(polygon) },
    }));

    return {
      priority: features.map((feature) => ({ if: `in_${feature.id}`, multiply_by: '0' })),
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
