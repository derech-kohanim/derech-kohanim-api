import type { LatLng, Stringency } from '@shared';

/**
 * Fixed origin/destination pairs over the Bnei Brak demo zones, used by the avoidance test
 * harness (npm run verify). Chosen so the straight line between the endpoints crosses a zone,
 * which makes the "avoidance off must cross" assertion meaningful and keeps the mock engine
 * deterministic.
 */
export interface RoutingPreset {
  id: string;
  origin: LatLng;
  destination: LatLng;
  stringency: Stringency;
  /** What the harness expects: a clean detour is achievable, or it must fail safe. */
  expect: 'clean' | 'fail_safe';
  /** For fail_safe endpoint cases, the reason code prefix expected. */
  reasonPrefix?: string;
}

export const ROUTING_PRESETS: RoutingPreset[] = [
  {
    id: 'akiva-crossing',
    origin: { lat: 32.077, lng: 34.825 },
    destination: { lat: 32.093, lng: 34.837 },
    stringency: 'basic',
    expect: 'clean',
  },
  {
    id: 'ramat-aharon-crossing',
    origin: { lat: 32.096, lng: 34.833 },
    destination: { lat: 32.086, lng: 34.85 },
    stringency: 'taharat',
    expect: 'clean',
  },
  {
    id: 'origin-inside-zone',
    // Origin sits inside the Rabbi Akiva demo polygon, so no route can ever be clean.
    origin: { lat: 32.0835, lng: 34.8325 },
    destination: { lat: 32.093, lng: 34.837 },
    stringency: 'basic',
    expect: 'fail_safe',
    reasonPrefix: 'endpoint_inside_zone',
  },
];
