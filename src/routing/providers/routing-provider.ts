import type { DraftManeuver } from '../../common/maneuver';
import type { GeoJsonLineString, GeoJsonPolygon, Language, LatLng, TravelMode } from '@shared';

export interface ProviderRouteRequest {
  origin: LatLng;
  destination: LatLng;
  mode: TravelMode;
  trafficAware: boolean;
  /** Polygons the provider should natively avoid. Ignored by providers that cannot. */
  avoidAreas: GeoJsonPolygon[];
  /** Waypoints the route must pass through (used by the heuristic fallback). */
  via?: LatLng[];
  /** Language for the provider's turn instructions. */
  language: Language;
  /** Avoid toll roads. Ignored by providers that cannot express it. */
  avoidTolls?: boolean;
  /**
   * How many ALTERNATIVE routes to request beyond the primary one, for `computeRoutes`.
   * 0 (or absent) means just the primary. Ignored by `computeRoute`.
   */
  alternatives?: number;
}

export interface ProviderRouteResponse {
  geometry: GeoJsonLineString;
  maneuvers: DraftManeuver[];
  distanceMeters: number;
  durationSeconds: number;
  /** Optional provider-side remark, surfaced in the debug attempt log. */
  note?: string;
}

/**
 * The seam. Swapping in a TomTomProvider must not require any change to RoutingService
 * (spec section 6.3).
 */
export interface RoutingProvider {
  readonly name: string;
  /** ToS attribution string shown next to the route. */
  readonly attribution: string;
  /** Whether the provider can block polygons inside its own graph search. */
  readonly supportsNativeAvoidance: boolean;
  /** Whether `trafficAware` actually reaches a live-traffic model upstream. */
  readonly supportsLiveTraffic: boolean;

  computeRoute(request: ProviderRouteRequest): Promise<ProviderRouteResponse>;

  /**
   * Returns the primary route plus up to `request.alternatives` native alternatives. Providers
   * that cannot produce alternatives may omit this; RoutingService then falls back to a single
   * `computeRoute`. Each element is an independent candidate; the caller verifies every one.
   */
  computeRoutes?(request: ProviderRouteRequest): Promise<ProviderRouteResponse[]>;
}
