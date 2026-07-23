import { Injectable, Logger } from '@nestjs/common';

import { decodeFlexiblePolyline } from '../../common/flexible-polyline';
import { outerRingLatLng } from '../../common/geo';
import { normalizeAction, type DraftManeuver } from '../../common/maneuver';
import { config } from '../../config';
import type {
  ProviderRouteRequest,
  ProviderRouteResponse,
  RoutingProvider,
} from './routing-provider';
import type { GeoJsonPolygon, LatLng } from '@shared';

const HERE_ROUTES_URL = 'https://router.hereapi.com/v8/routes';

/** HERE v8 accepts at most 20 avoid areas per request. */
const MAX_AVOID_AREAS = 20;

interface HereAction {
  action?: string;
  direction?: string;
  instruction?: string;
  offset?: number;
  nextRoad?: { name?: { value?: string }[] };
  currentRoad?: { name?: { value?: string }[] };
}

interface HereSection {
  polyline: string;
  summary?: { length?: number; duration?: number; baseDuration?: number };
  actions?: HereAction[];
}

interface HereRoutesResponse {
  routes?: { sections?: HereSection[] }[];
  notices?: { title?: string; code?: string }[];
  title?: string;
  cause?: string;
  error_description?: string;
}

@Injectable()
export class HereProvider implements RoutingProvider {
  readonly name = 'here';
  readonly attribution = 'Routing provided by HERE';
  readonly supportsNativeAvoidance = true;
  readonly supportsLiveTraffic = true;

  private readonly logger = new Logger(HereProvider.name);

  /**
   * Flipped to false the first time HERE rejects `polygon:` avoid areas, after which we
   * degrade to the always supported `bbox:` form for the rest of the process lifetime.
   */
  private polygonAvoidSupported = true;

  async computeRoute(request: ProviderRouteRequest): Promise<ProviderRouteResponse> {
    if (!config.hereApiKey) {
      throw new Error('HERE_API_KEY is not configured');
    }

    try {
      return await this.request(request, this.polygonAvoidSupported);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const rejectedAvoid =
        this.polygonAvoidSupported && request.avoidAreas.length > 0 && /avoid/i.test(message);

      if (!rejectedAvoid) throw error;

      this.logger.warn(
        `HERE rejected polygon avoid areas (${message}); falling back to bbox avoid areas.`,
      );
      this.polygonAvoidSupported = false;
      return this.request(request, false);
    }
  }

  private async request(
    request: ProviderRouteRequest,
    usePolygons: boolean,
  ): Promise<ProviderRouteResponse> {
    const url = this.buildUrl(request, usePolygons);
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    const bodyText = await response.text();

    let body: HereRoutesResponse;
    try {
      body = JSON.parse(bodyText) as HereRoutesResponse;
    } catch {
      throw new Error(`HERE returned non-JSON response (${response.status}): ${bodyText}`);
    }

    if (!response.ok) {
      const detail = body.error_description ?? body.cause ?? body.title ?? bodyText;
      throw new Error(`HERE routing failed (${response.status}): ${detail}`);
    }

    const sections = body.routes?.[0]?.sections ?? [];
    if (sections.length === 0) {
      throw new Error('HERE returned no route sections for this request');
    }

    return this.toProviderResponse(sections);
  }

  private buildUrl(request: ProviderRouteRequest, usePolygons: boolean): string {
    const { origin, destination, mode, trafficAware, via = [], avoidAreas, language } = request;

    // Built by hand (not URLSearchParams) so the `avoid[areas]` bracket syntax survives.
    const params: string[] = [
      `transportMode=${mode === 'walk' ? 'pedestrian' : 'car'}`,
      `origin=${this.point(origin)}`,
      `destination=${this.point(destination)}`,
      `return=${encodeURIComponent('polyline,summary,actions,instructions')}`,
      'routingMode=fast',
      // HERE localises the turn instructions itself, including Hebrew.
      `lang=${language === 'en' ? 'en-US' : 'he-IL'}`,
    ];

    for (const waypoint of via) {
      params.push(`via=${this.point(waypoint)}`);
    }

    if (mode === 'drive' && !trafficAware) {
      // `any` = time-independent routing, the traffic-free baseline. Traffic-aware is the
      // default: v8 departs now with live traffic when departureTime is omitted. Do not send
      // the literal `now` - v8 rejects it as an invalid date and time.
      params.push('departureTime=any');
    }

    if (avoidAreas.length > 0) {
      const areas = avoidAreas
        .slice(0, MAX_AVOID_AREAS)
        .map((poly) => (usePolygons ? this.polygonArea(poly) : this.bboxArea(poly)))
        .join('|');
      params.push(`avoid[areas]=${encodeURIComponent(areas)}`);
    }

    params.push(`apikey=${encodeURIComponent(config.hereApiKey)}`);
    return `${HERE_ROUTES_URL}?${params.join('&')}`;
  }

  private point(p: LatLng): string {
    return `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
  }

  /** `polygon:lat1,lng1;lat2,lng2;...` */
  private polygonArea(poly: GeoJsonPolygon): string {
    const ring = outerRingLatLng(poly)
      .map(([lat, lng]) => `${lat.toFixed(6)},${lng.toFixed(6)}`)
      .join(';');
    return `polygon:${ring}`;
  }

  /** `bbox:west,south,east,north` - the universally supported fallback shape. */
  private bboxArea(poly: GeoJsonPolygon): string {
    const ring = poly.coordinates[0] ?? [];
    const lngs = ring.map(([lng]) => lng);
    const lats = ring.map(([, lat]) => lat);
    return `bbox:${Math.min(...lngs).toFixed(6)},${Math.min(...lats).toFixed(6)},${Math.max(
      ...lngs,
    ).toFixed(6)},${Math.max(...lats).toFixed(6)}`;
  }

  private toProviderResponse(sections: HereSection[]): ProviderRouteResponse {
    const coordinates: [number, number][] = [];
    const maneuvers: DraftManeuver[] = [];
    let distanceMeters = 0;
    let durationSeconds = 0;

    for (const section of sections) {
      const sectionStart = coordinates.length;
      const points = decodeFlexiblePolyline(section.polyline).points;

      for (const [lat, lng] of points) {
        const previous = coordinates[coordinates.length - 1];
        if (previous && previous[0] === lng && previous[1] === lat) continue; // section joint
        coordinates.push([lng, lat]);
      }

      distanceMeters += section.summary?.length ?? 0;
      durationSeconds += section.summary?.duration ?? 0;

      for (const action of section.actions ?? []) {
        const offset = action.offset ?? 0;
        const point = points[offset];
        if (!point) continue;
        maneuvers.push({
          instruction: action.instruction ?? action.action ?? '',
          action: normalizeAction(action.action, action.direction),
          point: { lat: point[0], lng: point[1] },
          geometryIndex: Math.min(sectionStart + offset, coordinates.length - 1),
          street:
            action.nextRoad?.name?.[0]?.value ?? action.currentRoad?.name?.[0]?.value ?? null,
        });
      }
    }

    return {
      geometry: { type: 'LineString', coordinates },
      maneuvers,
      distanceMeters: Math.round(distanceMeters),
      durationSeconds: Math.round(durationSeconds),
    };
  }
}
