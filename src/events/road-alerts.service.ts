import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';

import { angleBetween, bearing } from '../common/bearing';
import { locateOnRoute } from '../common/geo';
import { PG_POOL } from '../db/db.module';
import type { GeoJsonLineString, RouteEvent } from '@shared';

/** A camera or crossing farther than this from the route line is on another road. */
const MAX_OFFSET_METERS = 20;

/** A camera facing more than this away from the travel direction watches the other carriageway. */
const MAX_CAMERA_ANGLE_DEG = 60;

interface AlertRow {
  osm_id: string;
  type: 'speed_camera' | 'rail_crossing';
  max_speed_kmh: number | null;
  direction_deg: number | null;
  guarded: boolean | null;
  lng: number;
  lat: number;
}

/**
 * Speed cameras and level crossings along a route, from the OSM extract the maintainer imports
 * (scripts/import-osm-features.ts). Geometry-based, so it works for a route from any engine.
 */
@Injectable()
export class RoadAlertsService {
  private readonly logger = new Logger(RoadAlertsService.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async alongRoute(routeId: string, geometry: GeoJsonLineString): Promise<RouteEvent[]> {
    if (geometry.coordinates.length < 2) return [];
    let rows: AlertRow[];
    try {
      const result = await this.pool.query<AlertRow>(
        `WITH route AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS line)
         SELECT a.osm_id::text, a.type, a.max_speed_kmh, a.direction_deg, a.guarded,
                ST_X(a.geom) AS lng, ST_Y(a.geom) AS lat
           FROM road_alerts a, route r
          WHERE a.geom && ST_Expand(r.line, 0.0005)
            AND ST_DWithin(a.geom::geography, r.line::geography, $2)`,
        [JSON.stringify(geometry), MAX_OFFSET_METERS],
      );
      rows = result.rows;
    } catch (error) {
      // A database without the table yet (before its migration ran) has no alerts to add.
      this.logger.warn(`road alerts unavailable: ${(error as Error).message}`);
      return [];
    }

    const events: RouteEvent[] = [];
    for (const row of rows) {
      const location = { lat: row.lat, lng: row.lng };
      const located = locateOnRoute(geometry, location);
      if (!located) continue;

      if (row.type === 'speed_camera' && row.direction_deg !== null) {
        const travel = travelBearing(geometry, located.vertexIndex);
        if (travel !== null && angleBetween(travel, row.direction_deg) > MAX_CAMERA_ANGLE_DEG) {
          continue;
        }
      }

      events.push({
        id: `${routeId}-${row.type}-${row.osm_id}`,
        type: row.type,
        location,
        routeDistanceMeters: Math.round(located.travelledMeters),
        label: row.type === 'speed_camera' ? 'Speed camera' : 'Rail crossing',
        labelHe: row.type === 'speed_camera' ? 'מצלמת מהירות' : 'מפגש מסילת ברזל',
        ...(row.max_speed_kmh ? { maxSpeedKmh: row.max_speed_kmh } : {}),
        ...(row.guarded !== null && row.type === 'rail_crossing' ? { guarded: row.guarded } : {}),
      });
    }
    return events.sort((a, b) => a.routeDistanceMeters - b.routeDistanceMeters);
  }
}

/** Compass bearing of the route around a vertex, in degrees. */
export function travelBearing(geometry: GeoJsonLineString, vertex: number): number | null {
  const coords = geometry.coordinates;
  const from = coords[Math.max(0, vertex - 1)];
  const to = coords[Math.min(coords.length - 1, vertex + 1)];
  if (!from || !to || (from[0] === to[0] && from[1] === to[1])) return null;
  return bearing(from, to);
}
