import { cumulativeDistances } from '../common/geo';
import type {
  GeoJsonLineString,
  LatLng,
  Maneuver,
  RouteEvent,
  TrafficSegment,
} from '@shared';

/**
 * The seeded part of a route's event feed: zone events from the route's own zone_enter
 * maneuvers, two seeded community reports, and a heavy plus a moderate traffic stretch with
 * the delay they add.
 *
 * This mirrors mockEventsForRoute in derech-kohanim-web/src/navigation/events.ts exactly, so
 * the server feed is identical to the mock the client currently uses and the client can drop
 * its copy. Everything is derived from the geometry, so the same route always yields the same
 * feed - deterministic, no randomness.
 */
export interface SeededBundle {
  events: RouteEvent[];
  traffic: TrafficSegment[];
  delaySeconds: number;
}

export function buildSeededBundle(
  geometry: GeoJsonLineString,
  maneuvers: Maneuver[],
): SeededBundle {
  const points: LatLng[] = geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
  const totals = cumulativeDistances(geometry);
  const total = totals[totals.length - 1] ?? 0;

  const at = (fraction: number): { point: LatLng; index: number; distance: number } => {
    const index = Math.min(points.length - 1, Math.round(fraction * (points.length - 1)));
    return { point: points[index], index, distance: totals[index] ?? 0 };
  };

  const events: RouteEvent[] = [];

  // Zone events come from the maneuvers the server already injected.
  for (const maneuver of maneuvers) {
    if (maneuver.action === 'zone_enter' && maneuver.zone) {
      events.push({
        id: `zone-${maneuver.id}`,
        type: 'zone',
        location: maneuver.point,
        routeDistanceMeters:
          totals[Math.min(maneuver.geometryIndex, totals.length - 1)] ?? 0,
        label: maneuver.zone.name,
        labelHe: maneuver.zone.nameHe,
      });
    }
  }

  // Seeded community reports, spaced along the route.
  const police = at(0.28);
  events.push({
    id: 'seed-police',
    type: 'police',
    location: police.point,
    routeDistanceMeters: police.distance,
  });
  const hazard = at(0.7);
  events.push({
    id: 'seed-hazard',
    type: 'hazard',
    location: hazard.point,
    routeDistanceMeters: hazard.distance,
  });

  // A heavy jam and a moderate stretch, expressed as index ranges over the geometry.
  const heavyFrom = Math.round(points.length * 0.34);
  const heavyTo = Math.round(points.length * 0.46);
  const moderateFrom = Math.round(points.length * 0.6);
  const moderateTo = Math.round(points.length * 0.72);
  const traffic: TrafficSegment[] = [
    { fromIndex: heavyFrom, toIndex: heavyTo, level: 'heavy' },
    { fromIndex: moderateFrom, toIndex: moderateTo, level: 'moderate' },
  ];

  const jam = at(0.4);
  events.push({
    id: 'seed-traffic',
    type: 'traffic',
    location: jam.point,
    routeDistanceMeters: jam.distance,
  });

  const heavyMeters = (totals[heavyTo] ?? total) - (totals[heavyFrom] ?? 0);
  const moderateMeters = (totals[moderateTo] ?? total) - (totals[moderateFrom] ?? 0);
  const delaySeconds = Math.round(heavyMeters * 0.09 + moderateMeters * 0.04);

  return { events, traffic, delaySeconds };
}
