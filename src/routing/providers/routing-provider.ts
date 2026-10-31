import type { DraftManeuver } from '../../common/maneuver';
import type {
  GeoJsonLineString,
  GeoJsonPolygon,
  Language,
  LatLng,
  SpeedLimitSegment,
  Stringency,
  TravelMode,
} from '@shared';

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
  /**
   * The baked-zone profile that blocks exactly `avoidAreas`' full zone set (before any
   * corridor filtering): the stringency and the hash of its polygons. A provider that has a
   * prepared profile with this name may route on it instead of sending the polygons; any other
   * provider ignores it. See routing/baked-profiles.ts.
   */
  bakedZones?: { stringency: Stringency; hash: string };
}

export interface ProviderRouteResponse {
  geometry: GeoJsonLineString;
  maneuvers: DraftManeuver[];
  distanceMeters: number;
  durationSeconds: number;
  /** Optional provider-side remark, surfaced in the debug attempt log. */
  note?: string;
  /** Speed limits along the geometry, when the engine knows them. */
  speedLimits?: SpeedLimitSegment[];
  /**
   * OSM way id per stretch of the geometry, as [fromIndex, toIndex, wayId] like a path
   * detail. Only the self-hosted GraphHopper provides it; lane guidance is looked up from it.
   */
  wayIds?: [number, number, number][];
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

  /**
   * Two-phase timing, for a provider whose shape and whose travel time come from different
   * engines (the hybrid). When present, `computeRoute`/`computeRoutes` return the shape carrying
   * only the shape engine's own time, and this fills in the real ETA.
   *
   * The split exists because the search is decided entirely on geometry and distance: a
   * candidate is chosen for being clean and short, never for its ETA. Pricing every candidate
   * therefore spent a second upstream call on routes about to be discarded - the dominant cost
   * of a slow compute. RoutingService now prices once, on the routes it actually returns.
   *
   * Called with the final routes and the original request; returns them in the same order.
   * Never throws: a provider that cannot reach its pricing engine returns the routes as they
   * came in, with a note.
   */
  priceRoutes?(
    routes: ProviderRouteResponse[],
    request: ProviderRouteRequest,
  ): Promise<ProviderRouteResponse[]>;
}
