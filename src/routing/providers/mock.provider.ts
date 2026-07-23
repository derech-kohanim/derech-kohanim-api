import { Injectable } from '@nestjs/common';

import { densify, lineLengthMeters } from '../../common/geo';
import type { DraftManeuver } from '../../common/maneuver';
import type {
  ProviderRouteRequest,
  ProviderRouteResponse,
  RoutingProvider,
} from './routing-provider';
import type { LatLng } from '@shared';

/** Rough average speeds, m/s. Traffic multiplies the drive duration. */
const SPEED = { drive: 11.1, walk: 1.4 };
const TRAFFIC_FACTOR = 1.35;
/** Points inserted per synthetic leg, mirrored from `densify`. */
const POINTS_PER_LEG = 24;

/**
 * Offline provider so the stack runs with no upstream key at all.
 *
 * It deliberately ignores `avoidAreas` - it models a provider with no native avoidance,
 * which means every clean route it produces had to come from RoutingService's own verify
 * plus heuristic-via fallback.
 */
@Injectable()
export class MockProvider implements RoutingProvider {
  readonly name = 'mock';
  readonly attribution = 'Routing simulated locally (MOCK - not a real routing engine)';
  readonly supportsNativeAvoidance = false;
  /** Simulated, not real - but `trafficAware` does change the number, so the toggle is live. */
  readonly supportsLiveTraffic = false;

  async computeRoute(request: ProviderRouteRequest): Promise<ProviderRouteResponse> {
    const waypoints: LatLng[] = [
      request.origin,
      ...(request.via ?? []),
      request.destination,
    ];

    const geometry = {
      type: 'LineString' as const,
      coordinates: densify(waypoints, POINTS_PER_LEG),
    };

    const distanceMeters = lineLengthMeters(geometry);
    const speed = SPEED[request.mode];
    const traffic = request.mode === 'drive' && request.trafficAware ? TRAFFIC_FACTOR : 1;

    return {
      geometry,
      maneuvers: this.buildManeuvers(waypoints, geometry.coordinates.length),
      distanceMeters: Math.round(distanceMeters),
      durationSeconds: Math.round((distanceMeters / speed) * traffic),
    };
  }

  private buildManeuvers(waypoints: LatLng[], vertexCount: number): DraftManeuver[] {
    const maneuvers: DraftManeuver[] = [
      {
        instruction: 'Head toward the destination',
        action: 'depart',
        point: waypoints[0],
        geometryIndex: 0,
        street: null,
      },
    ];

    waypoints.slice(1, -1).forEach((via, index) => {
      maneuvers.push({
        instruction: 'Continue via the detour waypoint',
        action: 'continue',
        point: via,
        geometryIndex: Math.min((index + 1) * POINTS_PER_LEG, vertexCount - 1),
        street: null,
      });
    });

    maneuvers.push({
      instruction: 'Arrive at the destination',
      action: 'arrive',
      point: waypoints[waypoints.length - 1],
      geometryIndex: vertexCount - 1,
      street: null,
    });
    return maneuvers;
  }
}
