import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';

import { PG_POOL } from '../db/db.module';
import { angleBetween, bearing } from '../common/bearing';
import { lanesForAction, parseTurnLanes, turnLanesFor, type TurnLaneWay } from './lanes';
import type { ProviderRouteResponse } from './providers/routing-provider';

interface LaneRow {
  way_id: string;
  turn_lanes: string | null;
  turn_lanes_forward: string | null;
  turn_lanes_backward: string | null;
  oneway: string | null;
  geojson: string;
}

interface WayWithGeometry extends TurnLaneWay {
  coordinates: [number, number][];
}

/**
 * Adds lane guidance to the manoeuvres of routes that carry OSM way ids (the self-hosted
 * GraphHopper). For each manoeuvre it takes the way the route uses just before the turn, picks
 * the turn-lane tag for the direction the route travels along it, and marks which lanes serve
 * the turn. Routes without way ids, and ways without lane tags, are left untouched.
 */
@Injectable()
export class LanesService {
  private readonly logger = new Logger(LanesService.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async annotate(routes: ProviderRouteResponse[]): Promise<void> {
    const wanted = new Set<string>();
    for (const route of routes) {
      for (const [, , id] of route.wayIds ?? []) wanted.add(String(id));
    }
    if (wanted.size === 0) return;

    let ways: Map<string, WayWithGeometry>;
    try {
      const { rows } = await this.pool.query<LaneRow>(
        `SELECT way_id::text, turn_lanes, turn_lanes_forward, turn_lanes_backward, oneway,
                ST_AsGeoJSON(geom) AS geojson
           FROM osm_turn_lanes
          WHERE way_id = ANY($1::bigint[])`,
        [[...wanted]],
      );
      ways = new Map(
        rows.map((row) => [
          row.way_id,
          {
            turnLanes: row.turn_lanes,
            turnLanesForward: row.turn_lanes_forward,
            turnLanesBackward: row.turn_lanes_backward,
            oneway: row.oneway,
            coordinates: (JSON.parse(row.geojson) as { coordinates: [number, number][] })
              .coordinates,
          },
        ]),
      );
    } catch (error) {
      this.logger.warn(`lane data unavailable: ${(error as Error).message}`);
      return;
    }
    if (ways.size === 0) return;

    for (const route of routes) {
      const coords = route.geometry.coordinates;
      for (const maneuver of route.maneuvers) {
        const index = maneuver.geometryIndex;
        if (index < 1 || index >= coords.length) continue;
        // The stretch that ends at the manoeuvre point is the approach.
        const entry = (route.wayIds ?? []).find(([from, to]) => from <= index - 1 && index - 1 < to);
        if (!entry) continue;
        const way = ways.get(String(entry[2]));
        if (!way) continue;

        const travel = bearing(coords[index - 1], coords[index]);
        const drawn = wayBearingNear(way.coordinates, coords[index]);
        if (drawn === null) continue;
        const tag = turnLanesFor(way, angleBetween(travel, drawn) < 90);
        if (!tag) continue;

        const lanes = lanesForAction(maneuver.action, parseTurnLanes(tag));
        if (lanes) maneuver.lanes = lanes;
      }
    }
  }
}

/** The way's drawing direction at the vertex nearest to a point. */
function wayBearingNear(coords: [number, number][], point: [number, number]): number | null {
  if (coords.length < 2) return null;
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  coords.forEach((c, i) => {
    const d = (c[0] - point[0]) ** 2 + (c[1] - point[1]) ** 2;
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  });
  const from = coords[Math.max(0, best - 1)];
  const to = coords[Math.min(coords.length - 1, best === 0 ? 1 : best)];
  if (from[0] === to[0] && from[1] === to[1]) return null;
  return bearing(from, to);
}
