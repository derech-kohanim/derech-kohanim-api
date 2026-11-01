import { createHash } from 'node:crypto';

import type { GeoJsonPolygon, Stringency } from '@shared';

/**
 * Baked-zone GraphHopper profiles.
 *
 * Sending every forbidden polygon with each request forces GraphHopper out of its prepared
 * modes and makes it test hundreds of polygons against every edge it touches; a cross-country
 * request with alternatives took over 30 seconds that way. Instead, each stringency gets its
 * own profile whose custom model already blocks that stringency's zones (cumulative, plus the
 * danger zones), and the profile is prepared with contraction hierarchies like the plain car
 * profile, so a zone-avoiding request costs what a plain one does.
 *
 * The profile name carries a hash of the exact polygon list it was built from. This module is
 * the ONE place that hash is computed: the graph build exports its models through
 * `scripts/export-graph-models.ts`, and the routing provider recomputes the name from the zones
 * it is about to avoid. A profile is used only when the two names match, so a graph built from
 * older zones can never route a request - the request falls back to sending the polygons.
 */

/** The polygons a baked profile blocks, in the order the API loads them. */
export function bakedZoneHash(polygons: GeoJsonPolygon[]): string {
  const canonical = polygons.map((polygon) => closedRings(polygon));
  return createHash('sha1').update(JSON.stringify(canonical)).digest('hex').slice(0, 12);
}

/**
 * GraphHopper profile names allow lowercase letters, digits and underscores. Toll avoidance gets
 * its own baked profile rather than a per-request rule: a per-request rule rules out speed mode,
 * and the zones in the profile then make every other mode slow.
 */
export function bakedProfileName(stringency: Stringency, hash: string, avoidTolls = false): string {
  return `car_${stringency}${avoidTolls ? '_notoll' : ''}_${hash}`;
}

export function bakedModelFileName(stringency: Stringency, avoidTolls = false): string {
  return `dk_zones_${stringency}${avoidTolls ? '_notoll' : ''}.json`;
}

/**
 * A custom model that makes every polygon impassable.
 *
 * GraphHopper evaluates an area by building the edge's bounding box and testing it against the
 * area, area by area, every time it weighs an edge - and preparing a graph weighs every edge
 * many times. One area per polygon (hundreds of them) made the preparation hundreds of times
 * slower than the plain profile. So the polygons are packed into a few MultiPolygon areas
 * (GraphHopper accepts any polygonal geometry), each tested through JTS's indexed prepared
 * geometry. Parts of one MultiPolygon must not overlap - JTS counts ring crossings, so an
 * overlap would read as outside - hence the greedy packing by disjoint bounding boxes.
 */
export function zoneBlockingModel(polygons: GeoJsonPolygon[]): {
  priority: { if: string; multiply_by: string }[];
  areas: { type: 'FeatureCollection'; features: unknown[] };
} {
  const features = packDisjoint(polygons).map((group, index) => ({
    type: 'Feature',
    id: `zones_${index}`,
    properties: {},
    geometry:
      group.length === 1
        ? { type: 'Polygon', coordinates: closedRings(group[0]) }
        : { type: 'MultiPolygon', coordinates: group.map((polygon) => closedRings(polygon)) },
  }));
  return {
    priority: features.map((feature) => ({ if: `in_${feature.id}`, multiply_by: '0' })),
    areas: { type: 'FeatureCollection', features },
  };
}

type Box = [number, number, number, number];

function boxOf(polygon: GeoJsonPolygon): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of polygon.coordinates[0] ?? []) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return [minX, minY, maxX, maxY];
}

function boxesTouch(a: Box, b: Box): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

/** Greedy first-fit into groups whose members' bounding boxes are pairwise disjoint. */
export function packDisjoint(polygons: GeoJsonPolygon[]): GeoJsonPolygon[][] {
  const groups: { members: GeoJsonPolygon[]; boxes: Box[] }[] = [];
  for (const polygon of polygons) {
    const box = boxOf(polygon);
    const group = groups.find((g) => g.boxes.every((other) => !boxesTouch(box, other)));
    if (group) {
      group.members.push(polygon);
      group.boxes.push(box);
    } else {
      groups.push({ members: [polygon], boxes: [box] });
    }
  }
  return groups.map((group) => group.members);
}

/** The toll rule layered onto a request when the driver avoids toll roads. */
export function tollBlockingModel(): { priority: { if: string; multiply_by: string }[] } {
  return {
    priority: [
      { if: 'toll == ALL', multiply_by: '0' },
      { if: 'toll == HGV', multiply_by: '0' },
    ],
  };
}

/** GraphHopper requires every ring to be explicitly closed. */
export function closedRings(polygon: GeoJsonPolygon): [number, number][][] {
  return polygon.coordinates.map((source) => {
    const ring = source.map((point) => [point[0], point[1]] as [number, number]);
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
      ring.push([first[0], first[1]]);
    }
    return ring;
  });
}
