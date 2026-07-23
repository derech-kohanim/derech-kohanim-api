import bbox from '@turf/bbox';
import booleanIntersects from '@turf/boolean-intersects';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import distance from '@turf/distance';
import { lineString, point as turfPoint, polygon as turfPolygon } from '@turf/helpers';
import turfLength from '@turf/length';
import pointToLineDistance from '@turf/point-to-line-distance';

import type { DraftManeuver } from './maneuver';
import type {
  GeoJsonLineString,
  GeoJsonPolygon,
  LatLng,
  ManeuverZone,
  ZoneFeature,
  ZoneManeuverType,
} from '@shared';

/**
 * A zone the router must avoid: a halachic stringency zone or a danger zone (Area A). The two
 * share geometry and verification; the `danger` flag distinguishes them so the alert can say
 * which it is. Stringency zones leave it undefined.
 */
export interface AvoidZone extends ZoneFeature {
  danger?: boolean;
}

export interface VerificationResult {
  clean: boolean;
  /** Zones the geometry actually intersects. Empty when `clean` is true. */
  offending: AvoidZone[];
}

/**
 * THE core safety check of the whole product: does the geometry we are about to hand the
 * user touch any forbidden zone? Never trust the routing provider's avoidance - verify.
 */
export function verifyRouteAgainstZones(
  geometry: GeoJsonLineString,
  zones: AvoidZone[],
): VerificationResult {
  if (geometry.coordinates.length < 2) {
    return { clean: false, offending: [] };
  }
  const line = lineString(geometry.coordinates);
  const offending = zones.filter((zone) =>
    booleanIntersects(line, turfPolygon(zone.geometry.coordinates)),
  );
  return { clean: offending.length === 0, offending };
}

/**
 * Keeps only the zones whose bounding box falls within the origin-destination corridor.
 *
 * With hundreds of real zones spread across the country, a route between two points can only
 * ever touch the handful near it; the rest are dead weight that would make the visibility-graph
 * detour planner and the provider avoid list blow up. The corridor is the O-D bounding box
 * expanded generously (by the full O-D span plus a floor), so any zone a returned route could
 * plausibly reach is retained - a far-away zone cannot be crossed and is safe to drop.
 */
export function zonesNearCorridor<T extends AvoidZone>(
  zones: T[],
  origin: LatLng,
  destination: LatLng,
): T[] {
  const spanLat = Math.abs(origin.lat - destination.lat);
  const spanLng = Math.abs(origin.lng - destination.lng);
  const margin = Math.max(spanLat, spanLng) + 0.05; // ~5.5 km floor

  const minLat = Math.min(origin.lat, destination.lat) - margin;
  const maxLat = Math.max(origin.lat, destination.lat) + margin;
  const minLng = Math.min(origin.lng, destination.lng) - margin;
  const maxLng = Math.max(origin.lng, destination.lng) + margin;

  return zones.filter((zone) => {
    const ring = zone.geometry.coordinates[0] ?? [];
    let zMinLng = Infinity;
    let zMinLat = Infinity;
    let zMaxLng = -Infinity;
    let zMaxLat = -Infinity;
    for (const [lng, lat] of ring) {
      if (lng < zMinLng) zMinLng = lng;
      if (lng > zMaxLng) zMaxLng = lng;
      if (lat < zMinLat) zMinLat = lat;
      if (lat > zMaxLat) zMaxLat = lat;
    }
    // Bounding-box overlap test.
    return !(zMaxLng < minLng || zMinLng > maxLng || zMaxLat < minLat || zMinLat > maxLat);
  });
}

/**
 * The `k` zones whose centre is closest to the straight origin-destination line.
 *
 * The visibility-graph detour planner is roughly cubic in the number of obstacle zones, so it
 * is fed only the handful nearest the direct path - the ones that could actually block a
 * near-direct route. This bounds the planner's cost; it never weakens safety, because the
 * final route is still verified against the FULL corridor set, so a route that slips past a
 * zone the planner ignored is rejected rather than returned.
 */
export function nearestZonesToSegment<T extends AvoidZone>(
  zones: T[],
  a: LatLng,
  b: LatLng,
  k: number,
): T[] {
  if (zones.length <= k) return zones;
  const line = lineString([
    [a.lng, a.lat],
    [b.lng, b.lat],
  ]);
  const scored = zones.map((zone) => {
    const ring = zone.geometry.coordinates[0] ?? [];
    let sx = 0;
    let sy = 0;
    for (const [lng, lat] of ring) {
      sx += lng;
      sy += lat;
    }
    const n = ring.length || 1;
    const d = pointToLineDistance(turfPoint([sx / n, sy / n]), line, {
      units: 'kilometers',
    });
    return { zone, d };
  });
  scored.sort((p, q) => p.d - q.d);
  return scored.slice(0, k).map((s) => s.zone);
}

/**
 * Replaces a zone's polygon with its axis-aligned bounding box.
 *
 * The detour planner builds a graph node per obstacle vertex, so a real zone with thousands of
 * vertices (some Area A polygons have over 3000) would explode the graph. The planner only
 * needs a rough obstacle to route around, and a bounding box is both tiny (four corners) and
 * conservative - it is larger than the zone, so a route planned clear of the box is clear of
 * the zone. The returned route is still verified against the true polygon.
 */
export function toBoundingBoxZone(zone: AvoidZone): AvoidZone {
  const ring = zone.geometry.coordinates[0] ?? [];
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of ring) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return {
    ...zone,
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [minLng, minLat],
          [maxLng, minLat],
          [maxLng, maxLat],
          [minLng, maxLat],
          [minLng, minLat],
        ],
      ],
    },
  };
}

/** Same check as `verifyRouteAgainstZones`, for callers that only hold raw polygons. */
export function intersectsAnyPolygon(
  geometry: GeoJsonLineString,
  polygons: GeoJsonPolygon[],
): boolean {
  if (geometry.coordinates.length < 2 || polygons.length === 0) return false;
  const line = lineString(geometry.coordinates);
  return polygons.some((polygon) => booleanIntersects(line, turfPolygon(polygon.coordinates)));
}

/** A straight two-point line - used to score candidate detours before calling the provider. */
function straightPath(points: LatLng[]): GeoJsonLineString {
  return {
    type: 'LineString',
    coordinates: points.map((p) => [p.lng, p.lat] as [number, number]),
  };
}

/**
 * Heuristic fallback (brief §2.4): when the provider hands back a route that still clips a
 * zone, we pick a "mid-avoidance" waypoint outside the offending zone and ask the provider
 * to route through it.
 *
 * Candidates are the offending zones' bbox corners and edge midpoints, pushed outward by
 * increasing pads. We keep only candidates whose straight origin to via to destination path is
 * itself zone-free, ordered by added travel distance.
 *
 * // PRODUCTION: replace with a proper visibility-graph / navmesh detour computed against
 * // the road network, instead of bbox corners on the great-circle path.
 */
export function suggestViaPoints(
  origin: LatLng,
  destination: LatLng,
  offending: ZoneFeature[],
  allZones: ZoneFeature[],
  limit = 6,
): LatLng[] {
  const scored: { point: LatLng; cost: number; penalty: number }[] = [];

  for (const zone of offending) {
    for (const candidate of ringAroundPolygon(zone.geometry)) {
      // Whether the straight origin to via to destination path is zone-free is a *ranking* signal,
      // not a filter. Roads are not straight lines: a candidate whose crow-flies path clips a
      // zone can still yield a perfectly clean road route, and those candidates are exactly
      // the ones needed when the destination sits right against a zone edge.
      const probe = straightPath([origin, candidate, destination]);
      const penalty = verifyRouteAgainstZones(probe, allZones).clean ? 0 : 1;

      const cost =
        distance([origin.lng, origin.lat], [candidate.lng, candidate.lat]) +
        distance([candidate.lng, candidate.lat], [destination.lng, destination.lat]);
      scored.push({ point: candidate, cost, penalty });
    }
  }

  // Straight-line cost is only a ranking heuristic - the caller still measures the routes
  // the provider actually returns and keeps the shortest clean one.
  scored.sort((a, b) => a.penalty - b.penalty || a.cost - b.cost);

  // Spread the picks out. Six neighbouring points on the same edge all fail (or succeed)
  // together; six points on different sides of the zone are six genuinely different ideas.
  const chosen: LatLng[] = [];
  for (const { point } of scored) {
    const tooClose = chosen.some(
      (p) =>
        Math.abs(p.lat - point.lat) < MIN_CANDIDATE_SEPARATION &&
        Math.abs(p.lng - point.lng) < MIN_CANDIDATE_SEPARATION,
    );
    if (!tooClose) chosen.push(point);
    if (chosen.length >= limit) break;
  }
  return chosen;
}

/** ~250 m. Candidates closer than this to an already-chosen one are redundant. */
const MIN_CANDIDATE_SEPARATION = 0.0025;

/** Outward offsets, in degrees, for the visibility-graph corner nodes (~90 m and ~280 m). */
const GRAPH_PADS = [0.0008, 0.0025];

/**
 * Plans a whole detour instead of a single waypoint.
 *
 * A single mid-route via point cannot express "go around zone A, then thread the gap
 * between B and C" - and when several zones wall off the destination, that is exactly what
 * is needed. So we build a small **visibility graph**: nodes are the origin, the
 * destination, and every zone corner pushed outward; an edge exists between two nodes only
 * if the straight segment between them touches no zone. Dijkstra over that graph gives the
 * shortest zone-free polyline, whose bend points become the waypoints handed to the
 * provider - in a single routing call.
 *
 * Returns an empty array when the direct line is already clean, and `null` when no
 * zone-free chain of nodes exists at all (a genuinely walled-off destination).
 *
 * // PRODUCTION: run the same search over the real road-network graph with the zone
 * // polygons cut out, instead of over corner nodes in open space.
 */
export function planDetourWaypoints(
  origin: LatLng,
  destination: LatLng,
  zones: ZoneFeature[],
  maxWaypoints = 6,
  pads: number[] = GRAPH_PADS,
): LatLng[] | null {
  const isClean = (a: LatLng, b: LatLng): boolean =>
    verifyRouteAgainstZones(straightPath([a, b]), zones).clean;

  if (isClean(origin, destination)) return [];

  const nodes: LatLng[] = [origin, destination];
  for (const zone of zones) {
    for (const corner of paddedCorners(zone.geometry, pads)) {
      // A node inside another zone is useless as a stepping stone.
      if (
        zones.some((other) =>
          booleanPointInPolygon(
            turfPoint([corner.lng, corner.lat]),
            turfPolygon(other.geometry.coordinates),
          ),
        )
      ) {
        continue;
      }
      nodes.push(corner);
    }
  }

  const count = nodes.length;
  const INF = Number.POSITIVE_INFINITY;
  const dist = new Array<number>(count).fill(INF);
  const previous = new Array<number>(count).fill(-1);
  const settled = new Array<boolean>(count).fill(false);
  dist[0] = 0;

  // Edge weights are computed lazily: most pairs are never relaxed.
  const weight = (i: number, j: number): number =>
    isClean(nodes[i], nodes[j])
      ? distance([nodes[i].lng, nodes[i].lat], [nodes[j].lng, nodes[j].lat])
      : INF;

  for (let step = 0; step < count; step++) {
    let current = -1;
    let bestDistance = INF;
    for (let i = 0; i < count; i++) {
      if (!settled[i] && dist[i] < bestDistance) {
        bestDistance = dist[i];
        current = i;
      }
    }
    if (current === -1 || current === 1) break; // unreachable, or destination settled
    settled[current] = true;

    for (let next = 0; next < count; next++) {
      if (settled[next]) continue;
      const edge = weight(current, next);
      if (edge === INF) continue;
      const candidate = dist[current] + edge;
      if (candidate < dist[next]) {
        dist[next] = candidate;
        previous[next] = current;
      }
    }
  }

  if (dist[1] === INF) return null;

  const path: number[] = [];
  for (let node = 1; node !== -1; node = previous[node]) path.unshift(node);

  // Bend points alone leave the provider free to wander between them - and it wanders
  // straight back into a zone. Sampling along the planned (zone-free) polyline pins the
  // route down much harder, at no extra routing calls.
  const full = path.map((index) => nodes[index]);
  const dense = densifyWaypoints(full, WAYPOINT_SPACING_METERS);
  return dense.length > maxWaypoints ? thinTo(dense, maxWaypoints) : dense;
}

/** Target spacing between planned waypoints. Closer = tighter grip, more snapping noise. */
const WAYPOINT_SPACING_METERS = 500;

/** Samples the interior of a planned path so consecutive waypoints stay within `spacing`. */
function densifyWaypoints(path: LatLng[], spacing: number): LatLng[] {
  const out: LatLng[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const from = path[i];
    const to = path[i + 1];
    const legMeters =
      distance([from.lng, from.lat], [to.lng, to.lat], { units: 'kilometers' }) * 1000;
    const steps = Math.max(1, Math.round(legMeters / spacing));

    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      out.push({
        lat: from.lat + (to.lat - from.lat) * t,
        lng: from.lng + (to.lng - from.lng) * t,
      });
    }
  }
  // The last entry is the destination itself, which the provider already has.
  return out.slice(0, -1);
}

/** Evenly drops waypoints until at most `limit` remain, keeping the shape. */
function thinTo(points: LatLng[], limit: number): LatLng[] {
  const stride = points.length / limit;
  const kept: LatLng[] = [];
  for (let i = 0; i < limit; i++) kept.push(points[Math.floor(i * stride)]);
  return kept;
}

/**
 * Clearance levels for the planner, tried in order. A tight plan is shortest but invites the
 * provider to cut the corner straight back into the zone; a wide one costs distance and is
 * far harder to cut.
 */
export const PLANNER_CLEARANCES: number[][] = [
  [0.0008, 0.0025], // ~90 m, ~280 m
  [0.005, 0.009], // ~550 m, ~1 km
  [0.015, 0.025], // ~1.7 km, ~2.8 km
];

/** The polygon's corners, pushed outward from its centre at each pad distance. */
function paddedCorners(polygon: GeoJsonPolygon, pads: number[] = GRAPH_PADS): LatLng[] {
  const ring = polygon.coordinates[0] ?? [];
  if (ring.length < 4) return [];

  const [minX, minY, maxX, maxY] = bbox(turfPolygon(polygon.coordinates));
  const centreLng = (minX + maxX) / 2;
  const centreLat = (minY + maxY) / 2;

  const corners: LatLng[] = [];
  for (let i = 0; i < ring.length - 1; i++) {
    const [lng, lat] = ring[i];
    const dLng = lng - centreLng;
    const dLat = lat - centreLat;
    const norm = Math.hypot(dLng, dLat) || 1;
    for (const pad of pads) {
      corners.push({
        lat: lat + (dLat / norm) * pad,
        lng: lng + (dLng / norm) * pad,
      });
    }
  }
  return corners;
}

/** Samples per polygon edge when building the detour ring. */
const RING_SAMPLES_PER_EDGE = 5;
/** Outward offsets in degrees: roughly 90 m, 180 m, 350 m, 700 m. */
const RING_PADS = [0.0008, 0.0016, 0.0032, 0.0064];

/**
 * Builds a ring of candidate detour points that surrounds the polygon: the outline is
 * sampled (corners plus points along every edge) and each sample is pushed outward, away
 * from the polygon's centre, at several distances.
 *
 * This replaces picking only the four bbox corners, which forced the route to swing around
 * the whole zone even when slipping past one edge would do.
 *
 * // PRODUCTION: snap each candidate to the nearest road with a road-network graph, and
 * // search that graph directly instead of sampling geometry.
 */
function ringAroundPolygon(polygon: GeoJsonPolygon): LatLng[] {
  const ring = polygon.coordinates[0] ?? [];
  if (ring.length < 4) return [];

  const [minX, minY, maxX, maxY] = bbox(turfPolygon(polygon.coordinates));
  const centreLng = (minX + maxX) / 2;
  const centreLat = (minY + maxY) / 2;

  const samples: [number, number][] = [];
  for (let i = 0; i < ring.length - 1; i++) {
    const [lngA, latA] = ring[i];
    const [lngB, latB] = ring[i + 1];
    for (let step = 0; step < RING_SAMPLES_PER_EDGE; step++) {
      const t = step / RING_SAMPLES_PER_EDGE;
      samples.push([lngA + (lngB - lngA) * t, latA + (latB - latA) * t]);
    }
  }

  const points: LatLng[] = [];
  for (const [lng, lat] of samples) {
    // Outward direction = away from the centre. Exact for convex shapes, good enough for
    // the mildly concave ones real zone layers contain.
    const dLng = lng - centreLng;
    const dLat = lat - centreLat;
    const norm = Math.hypot(dLng, dLat) || 1;

    for (const pad of RING_PADS) {
      points.push({
        lat: lat + (dLat / norm) * pad,
        lng: lng + (dLng / norm) * pad,
      });
    }
  }
  return points;
}

/**
 * Injects zone warnings into the turn list.
 *
 * A banner is not enough: if the route enters (or starts/ends in) a forbidden zone, the
 * driver must see it at the exact step where it happens. Provider maneuvers that fall inside
 * a zone are tagged, and synthetic `zone_enter` / `zone_exit` entries are inserted at the
 * crossings, in route order.
 *
 * Sampling is done on vertices and segment midpoints, so a zone small enough to sit between
 * two vertices is still caught.
 */
export function annotateManeuversWithZones(
  geometry: GeoJsonLineString,
  maneuvers: DraftManeuver[],
  zones: AvoidZone[],
): DraftManeuver[] {
  const coordinates = geometry.coordinates;
  if (zones.length === 0 || coordinates.length < 2) return maneuvers;

  const zoneAt = (lng: number, lat: number): AvoidZone | undefined =>
    zones.find((zone) =>
      booleanPointInPolygon(turfPoint([lng, lat]), turfPolygon(zone.geometry.coordinates)),
    );

  // Sample index s maps to vertex index floor(s / 2): even = vertex, odd = following midpoint.
  const samples: {
    vertex: number;
    zone: AvoidZone | undefined;
    lng: number;
    lat: number;
  }[] = [];
  for (let i = 0; i < coordinates.length; i++) {
    const [lng, lat] = coordinates[i];
    samples.push({ vertex: i, zone: zoneAt(lng, lat), lng, lat });
    if (i < coordinates.length - 1) {
      const [nextLng, nextLat] = coordinates[i + 1];
      const midLng = (lng + nextLng) / 2;
      const midLat = (lat + nextLat) / 2;
      samples.push({ vertex: i, zone: zoneAt(midLng, midLat), lng: midLng, lat: midLat });
    }
  }

  const lastVertex = coordinates.length - 1;
  const entries: { vertex: number; order: number; maneuver: DraftManeuver }[] = [];

  for (let s = 0; s < samples.length; s++) {
    const current = samples[s];
    const previous = s === 0 ? undefined : samples[s - 1];
    if (current.zone && current.zone !== previous?.zone) {
      const atOrigin = s === 0;
      entries.push({
        vertex: current.vertex,
        order: 0,
        maneuver: zoneManeuver(
          atOrigin ? 'zone_origin' : 'zone_enter',
          current.zone,
          { lat: current.lat, lng: current.lng },
          current.vertex,
        ),
      });
    }
    if (!current.zone && previous?.zone) {
      entries.push({
        vertex: current.vertex,
        order: 0,
        maneuver: zoneManeuver(
          'zone_exit',
          previous.zone,
          { lat: current.lat, lng: current.lng },
          current.vertex,
        ),
      });
    }
  }

  // A destination inside a zone deserves its own, unmistakable entry.
  const finalZone = samples[samples.length - 1]?.zone;
  if (finalZone) {
    const [lng, lat] = coordinates[lastVertex];
    entries.push({
      vertex: lastVertex,
      order: 2,
      maneuver: zoneManeuver('zone_destination', finalZone, { lat, lng }, lastVertex),
    });
  }

  for (const maneuver of maneuvers) {
    const vertex = maneuver.geometryIndex;
    const zone = zoneAt(maneuver.point.lng, maneuver.point.lat);
    entries.push({
      vertex,
      order: 1,
      maneuver: zone ? { ...maneuver, zone: toManeuverZone(zone) } : maneuver,
    });
  }

  entries.sort((a, b) => a.vertex - b.vertex || a.order - b.order);
  return entries.map((entry) => entry.maneuver);
}

export function toManeuverZone(zone: AvoidZone): ManeuverZone {
  return {
    name: zone.properties.name,
    nameHe: zone.properties.nameHe,
    stringency: zone.properties.stringency,
    description: zone.properties.description ?? null,
    city: zone.properties.city ?? null,
    ...(zone.danger ? { danger: true } : {}),
  };
}

/** The client renders these from `action` plus `zone`; `instruction` is a text fallback. */
function zoneManeuver(
  action: ZoneManeuverType,
  zone: AvoidZone,
  point: LatLng,
  geometryIndex: number,
): DraftManeuver {
  const kind = zone.danger ? 'danger zone' : 'forbidden zone';
  const label = `${zone.properties.name}${
    zone.properties.city ? `, ${zone.properties.city}` : ''
  }`;
  const instruction =
    action === 'zone_exit'
      ? `Leaving ${kind}: ${label}`
      : action === 'zone_origin'
        ? `The origin is inside a ${kind}: ${label}`
        : action === 'zone_destination'
          ? `The destination is inside a ${kind}: ${label}`
          : `From here on, ${kind}: ${label}`;

  return {
    instruction,
    action,
    point,
    geometryIndex,
    street: null,
    zone: toManeuverZone(zone),
  };
}

export function nearestVertexIndex(
  coordinates: [number, number][],
  point: LatLng,
): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < coordinates.length; i++) {
    const dLng = coordinates[i][0] - point.lng;
    const dLat = coordinates[i][1] - point.lat;
    const squared = dLng * dLng + dLat * dLat;
    if (squared < bestDistance) {
      bestDistance = squared;
      best = i;
    }
  }
  return best;
}

/** Distance from the first vertex to every vertex, in meters. */
export function cumulativeDistances(geometry: GeoJsonLineString): number[] {
  const coordinates = geometry.coordinates;
  const out: number[] = new Array(coordinates.length).fill(0);
  for (let i = 1; i < coordinates.length; i++) {
    out[i] =
      out[i - 1] +
      distance(coordinates[i - 1], coordinates[i], { units: 'kilometers' }) * 1000;
  }
  return out;
}

/** Great-circle distance between two points, in meters. */
export function metersBetween(a: LatLng, b: LatLng): number {
  return distance([a.lng, a.lat], [b.lng, b.lat], { units: 'kilometers' }) * 1000;
}

export interface RoutePosition {
  /** Index of the geometry vertex the driver is closest to. */
  vertexIndex: number;
  /** Perpendicular distance from the route line, in meters. */
  offsetMeters: number;
  /** Distance already covered along the route, in meters. */
  travelledMeters: number;
}

/**
 * Snaps a live position onto the route. Everything the progress endpoint reports - the
 * current step, the distance to it and the remaining distance - is derived from this.
 */
export function locateOnRoute(
  geometry: GeoJsonLineString,
  position: LatLng,
): RoutePosition | null {
  const coordinates = geometry.coordinates;
  if (coordinates.length < 2) return null;

  const cumulative = cumulativeDistances(geometry);
  let bestIndex = 0;
  let bestOffset = Number.POSITIVE_INFINITY;
  let bestTravelled = 0;

  for (let i = 0; i < coordinates.length - 1; i++) {
    const projected = projectOnSegment(position, coordinates[i], coordinates[i + 1]);
    const offset = metersBetween(position, projected.point);
    if (offset < bestOffset) {
      bestOffset = offset;
      bestIndex = projected.ratio > 0.5 ? i + 1 : i;
      const segmentMeters = cumulative[i + 1] - cumulative[i];
      bestTravelled = cumulative[i] + segmentMeters * projected.ratio;
    }
  }

  return {
    vertexIndex: bestIndex,
    offsetMeters: bestOffset,
    travelledMeters: bestTravelled,
  };
}

/** Planar projection - accurate enough at the scale of a single route segment. */
function projectOnSegment(
  position: LatLng,
  from: [number, number],
  to: [number, number],
): { point: LatLng; ratio: number } {
  const scale = Math.cos((position.lat * Math.PI) / 180) || 1;
  const ax = from[0] * scale;
  const ay = from[1];
  const bx = to[0] * scale;
  const by = to[1];
  const px = position.lng * scale;
  const py = position.lat;

  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const ratio =
    lengthSquared === 0
      ? 0
      : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));

  return {
    point: { lat: ay + dy * ratio, lng: (ax + dx * ratio) / scale },
    ratio,
  };
}

/** The nearest zone to a live position, with its distance. Drives the driving alert. */
export function nearestZone(
  position: LatLng,
  zones: AvoidZone[],
): { zone: AvoidZone; distanceMeters: number; inside: boolean } | null {
  let best: { zone: AvoidZone; distanceMeters: number; inside: boolean } | null = null;

  for (const zone of zones) {
    const polygon = turfPolygon(zone.geometry.coordinates);
    const inside = booleanPointInPolygon(turfPoint([position.lng, position.lat]), polygon);
    const ring = zone.geometry.coordinates[0] ?? [];
    const meters = inside
      ? 0
      : pointToLineDistance(turfPoint([position.lng, position.lat]), lineString(ring), {
          units: 'kilometers',
        }) * 1000;
    if (!best || meters < best.distanceMeters) {
      best = { zone, distanceMeters: Math.round(meters), inside };
    }
  }
  return best;
}

/**
 * Largest distance, in meters, from any vertex of `candidate` to the `reference` line.
 *
 * Used to decide whether a second provider actually followed a route planned by the first,
 * or quietly took its own way. Sampling the candidate's vertices is enough: a deviation big
 * enough to matter always shows up at a vertex.
 */
export function maxDeviationMeters(
  reference: GeoJsonLineString,
  candidate: GeoJsonLineString,
): number {
  if (reference.coordinates.length < 2 || candidate.coordinates.length === 0) {
    return Number.POSITIVE_INFINITY;
  }

  const line = lineString(reference.coordinates);
  let worst = 0;
  for (const [lng, lat] of candidate.coordinates) {
    const metres =
      pointToLineDistance(turfPoint([lng, lat]), line, { units: 'kilometers' }) * 1000;
    if (metres > worst) worst = metres;
  }
  return worst;
}

/**
 * Waypoints spaced evenly **by distance** along a line, endpoints excluded.
 *
 * Sampling by vertex index would be wrong: routers emit many vertices on curves and very few
 * on long straight stretches, so an index-based sample leaves kilometres of motorway with no
 * waypoint at all - and that is precisely where another engine is then free to take a
 * different road.
 */
export function sampleWaypoints(geometry: GeoJsonLineString, count: number): LatLng[] {
  const coordinates = geometry.coordinates;
  if (coordinates.length <= 2 || count <= 0) return [];

  const legs: number[] = [];
  let total = 0;
  for (let i = 0; i < coordinates.length - 1; i++) {
    const leg =
      distance(coordinates[i], coordinates[i + 1], { units: 'kilometers' }) * 1000;
    legs.push(leg);
    total += leg;
  }
  if (total === 0) return [];

  const spacing = total / (count + 1);
  const points: LatLng[] = [];
  let target = spacing;
  let travelled = 0;

  for (let i = 0; i < legs.length && points.length < count; i++) {
    const legEnd = travelled + legs[i];
    while (target <= legEnd && points.length < count) {
      const ratio = legs[i] === 0 ? 0 : (target - travelled) / legs[i];
      const [lngA, latA] = coordinates[i];
      const [lngB, latB] = coordinates[i + 1];
      points.push({
        lat: latA + (latB - latA) * ratio,
        lng: lngA + (lngB - lngA) * ratio,
      });
      target += spacing;
    }
    travelled = legEnd;
  }

  return points;
}

/** Great-circle length of a LineString, in meters. */
export function lineLengthMeters(geometry: GeoJsonLineString): number {
  if (geometry.coordinates.length < 2) return 0;
  return turfLength(lineString(geometry.coordinates), { units: 'kilometers' }) * 1000;
}

/** Insert intermediate points so a synthetic leg looks (and verifies) like a real route. */
export function densify(points: LatLng[], perSegment = 24): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    for (let step = 0; step < perSegment; step++) {
      const t = step / perSegment;
      out.push([a.lng + (b.lng - a.lng) * t, a.lat + (b.lat - a.lat) * t]);
    }
  }
  const last = points[points.length - 1];
  out.push([last.lng, last.lat]);
  return out;
}

/** GeoJSON polygon to the outer ring as [lat, lng] pairs (HERE's coordinate order). */
export function outerRingLatLng(poly: GeoJsonPolygon): [number, number][] {
  const ring = poly.coordinates[0] ?? [];
  const closed =
    ring.length > 1 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1];
  const points = closed ? ring.slice(0, -1) : ring;
  return points.map(([lng, lat]) => [lat, lng] as [number, number]);
}
