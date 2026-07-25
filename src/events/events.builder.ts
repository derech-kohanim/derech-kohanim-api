import { cumulativeDistances } from '../common/geo';
import type {
  GeoJsonLineString,
  Maneuver,
  RouteEvent,
  TrafficSegment,
} from '@shared';

/**
 * The derived part of a route's event feed: zone events from the route's own zone_enter
 * maneuvers. These are real - every zone event corresponds to a forbidden zone the route
 * actually crosses, so the same route always yields the same zone events.
 *
 * No community reports or traffic are fabricated here: those must come from a real source
 * (persisted user reports, and a real traffic provider once one exists). Until then traffic is
 * empty and adds no delay, so phantom police/hazard/traffic no longer appear in navigation.
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
  const totals = cumulativeDistances(geometry);

  const events: RouteEvent[] = [];

  // Zone events come from the maneuvers the server already injected - they are derived from
  // the route's own zone_enter maneuvers, so they are real, not fabricated.
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

  // No fabricated community reports and no fake traffic: real user reports are merged in by
  // EventsService, and traffic stays empty (zero delay) until a real traffic source exists.
  return { events, traffic: [], delaySeconds: 0 };
}
