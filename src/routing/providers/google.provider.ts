import { Injectable, Logger } from '@nestjs/common';

import { decodeEncodedPolyline } from '../../common/encoded-polyline';
import { intersectsAnyPolygon, nearestVertexIndex } from '../../common/geo';
import { normalizeAction, type DraftManeuver } from '../../common/maneuver';
import { config } from '../../config';
import type {
  ProviderRouteRequest,
  ProviderRouteResponse,
  RoutingProvider,
} from './routing-provider';
import type { GeoJsonPolygon, LatLng } from '@shared';

const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

/** Only the fields we consume - the Routes API rejects requests without a field mask. */
const FIELD_MASK = [
  'routes.duration',
  'routes.distanceMeters',
  'routes.polyline.encodedPolyline',
  'routes.legs.steps.navigationInstruction',
  'routes.legs.steps.startLocation',
].join(',');

interface GoogleLatLng {
  latitude: number;
  longitude: number;
}

interface GoogleStep {
  navigationInstruction?: { maneuver?: string; instructions?: string };
  startLocation?: { latLng?: GoogleLatLng };
}

interface GoogleRoute {
  distanceMeters?: number;
  /** Protobuf duration, e.g. "512s". */
  duration?: string;
  polyline?: { encodedPolyline?: string };
  legs?: { steps?: GoogleStep[] }[];
}

interface GoogleRoutesResponse {
  routes?: GoogleRoute[];
  error?: { code?: number; message?: string; status?: string };
}

/**
 * Google Routes API provider.
 *
 * Google's routing engine has no polygon-avoidance capability (`avoid` only covers
 * tolls, highways and ferries), so `avoidAreas` is deliberately ignored here. Every clean
 * route this provider yields therefore came from RoutingService's own verification plus an
 * injected via point. Per spec section 6.3 it is not eligible as the primary engine.
 *
 * Traffic, on the other hand, is native, which is what makes it useful inside the hybrid
 * engine as the pricing half.
 */
@Injectable()
export class GoogleProvider implements RoutingProvider {
  readonly name = 'google';
  readonly attribution = 'Routing provided by Google';
  readonly supportsNativeAvoidance = false;
  readonly supportsLiveTraffic = true;

  private readonly logger = new Logger(GoogleProvider.name);

  async computeRoute(request: ProviderRouteRequest): Promise<ProviderRouteResponse> {
    if (!config.googleRoutesApiKey) {
      throw new Error('GOOGLE_ROUTES_API_KEY is not configured');
    }
    if (request.avoidAreas.length > 0) {
      this.logger.debug(
        `Ignoring ${request.avoidAreas.length} avoid area(s): the Google Routes API cannot ` +
          'avoid polygons. RoutingService verifies and detours instead.',
      );
    }

    const response = await fetch(ROUTES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': config.googleRoutesApiKey,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify(this.buildBody(request)),
    });

    const bodyText = await response.text();
    let body: GoogleRoutesResponse;
    try {
      body = JSON.parse(bodyText) as GoogleRoutesResponse;
    } catch {
      throw new Error(
        `Google Routes returned non-JSON response (${response.status}): ${bodyText}`,
      );
    }

    if (!response.ok || body.error) {
      // Provider errors are passed through verbatim: "service not enabled" reads nothing
      // like "bad key", and wrapping it hides the fix (spec section 16.4).
      const detail = body.error?.message ?? bodyText;
      throw new Error(`Google routing failed (${response.status}): ${detail}`);
    }

    const routes = (body.routes ?? []).filter((r) => r.polyline?.encodedPolyline);
    if (routes.length === 0) {
      throw new Error('Google Routes returned no route for this request');
    }

    return this.pickBest(routes, request.avoidAreas);
  }

  /**
   * Google's top POC recommendation (section 4.3): when we ask it to avoid, request
   * alternatives in the same call and keep the one that best clears the zones. Google cannot
   * block polygons, but its alternatives are genuinely different corridors, so this is the
   * cheapest way to hand the verifier a clean starting point - one call, up to three chances.
   *
   * Ranking is still only a hint: RoutingService verifies the winner and runs the detour
   * search if even the best alternative clips a zone.
   */
  private pickBest(routes: GoogleRoute[], avoidAreas: GeoJsonPolygon[]): ProviderRouteResponse {
    const responses = routes.map((route) => this.toProviderResponse(route));
    if (avoidAreas.length === 0) return responses[0];

    const clean = responses
      .filter((r) => !intersectsAnyPolygon(r.geometry, avoidAreas))
      .sort((a, b) => a.distanceMeters - b.distanceMeters);
    if (clean.length > 0) {
      return {
        ...clean[0],
        note:
          responses.length > 1
            ? `chose the clean one of ${responses.length} Google alternatives`
            : clean[0].note,
      };
    }

    // None clean: hand back the shortest, which the detour search will then work on.
    return responses.sort((a, b) => a.distanceMeters - b.distanceMeters)[0];
  }

  private buildBody(request: ProviderRouteRequest): Record<string, unknown> {
    const { origin, destination, mode, trafficAware, via = [], avoidAreas, language } = request;
    const isDrive = mode === 'drive';

    const body: Record<string, unknown> = {
      origin: this.waypoint(origin),
      destination: this.waypoint(destination),
      travelMode: isDrive ? 'DRIVE' : 'WALK',
      // Alternatives are only offered on a plain origin-to-destination request; Google
      // rejects them together with intermediates, so we only ask when there are no vias.
      computeAlternativeRoutes: avoidAreas.length > 0 && via.length === 0,
      polylineEncoding: 'ENCODED_POLYLINE',
      languageCode: language,
      units: 'METRIC',
    };

    if (via.length > 0) {
      // `via: true` marks these as pass-through milestones rather than stops. Without it the
      // Routes API treats every intermediate as a stopover and is free to approach and leave
      // each one however it likes, including U-turns back into a forbidden zone.
      body.intermediates = via.map((point) => ({
        ...this.waypoint(point),
        via: true,
        vehicleStopover: false,
      }));
    }

    // routingPreference is only valid for DRIVE; sending it for WALK is a 400.
    if (isDrive) {
      body.routingPreference = trafficAware ? 'TRAFFIC_AWARE' : 'TRAFFIC_UNAWARE';
    }

    return body;
  }

  private waypoint(point: LatLng): Record<string, unknown> {
    return { location: { latLng: { latitude: point.lat, longitude: point.lng } } };
  }

  private toProviderResponse(route: GoogleRoute): ProviderRouteResponse {
    const points = decodeEncodedPolyline(route.polyline!.encodedPolyline!);
    const coordinates = points.map(([lat, lng]) => [lng, lat] as [number, number]);

    const maneuvers: DraftManeuver[] = [];
    for (const leg of route.legs ?? []) {
      for (const step of leg.steps ?? []) {
        const instruction = step.navigationInstruction;
        const location = step.startLocation?.latLng;
        if (!instruction?.instructions || !location) continue;
        const point = { lat: location.latitude, lng: location.longitude };
        maneuvers.push({
          instruction: instruction.instructions,
          action: normalizeAction(instruction.maneuver),
          point,
          geometryIndex: nearestVertexIndex(coordinates, point),
          street: null,
        });
      }
    }

    return {
      geometry: { type: 'LineString', coordinates },
      maneuvers,
      distanceMeters: Math.round(route.distanceMeters ?? 0),
      durationSeconds: Math.round(parseFloat(route.duration ?? '0')),
    };
  }
}
