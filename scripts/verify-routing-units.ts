/**
 * Unit checks for the pure routing helpers: baked-profile naming, speed-limit segments, lane
 * parsing and the OSM value parsers. No database, no network.
 *
 *   npx tsx scripts/verify-routing-units.ts
 */
import assert from 'node:assert/strict';

import { angleBetween, bearing } from '../src/common/bearing';
import { maxDeviationMeters } from '../src/common/geo';
import { buildVoiceKeys } from '../src/common/maneuver';
import {
  bakedProfileName,
  bakedZoneHash,
  closedRings,
  zoneBlockingModel,
} from '../src/routing/baked-profiles';
import { lanesForAction, parseTurnLanes, turnLanesFor } from '../src/routing/lanes';
import { toSpeedLimits, toWayIds } from '../src/routing/providers/graphhopper-details';
import { parseDirection, parseMaxSpeed } from './import-osm-features';
import type { GeoJsonPolygon } from '@shared';

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  process.stdout.write(`PASS ${name}\n`);
}

const square: GeoJsonPolygon = {
  type: 'Polygon',
  coordinates: [[[35, 32], [35.001, 32], [35.001, 32.001], [35, 32.001]]],
};
const closedSquare: GeoJsonPolygon = {
  type: 'Polygon',
  coordinates: [[[35, 32], [35.001, 32], [35.001, 32.001], [35, 32.001], [35, 32]]],
};

check('baked hash ignores whether a ring is explicitly closed', () => {
  assert.equal(bakedZoneHash([square]), bakedZoneHash([closedSquare]));
});
check('baked hash depends on order and content', () => {
  const other: GeoJsonPolygon = { type: 'Polygon', coordinates: [[[34, 31], [34.1, 31], [34, 31.1]]] };
  assert.notEqual(bakedZoneHash([square, other]), bakedZoneHash([other, square]));
  assert.notEqual(bakedZoneHash([square]), bakedZoneHash([other]));
});
check('baked profile name is a valid GraphHopper profile name', () => {
  assert.match(bakedProfileName('taharat', bakedZoneHash([square])), /^car_taharat_[0-9a-f]{12}$/);
  assert.match(
    bakedProfileName('basic', bakedZoneHash([square]), true),
    /^car_basic_notoll_[0-9a-f]{12}$/,
  );
});
check('zone model packs disjoint polygons together and overlapping ones apart', () => {
  const far: GeoJsonPolygon = { type: 'Polygon', coordinates: [[[34, 31], [34.1, 31], [34, 31.1]]] };
  // square and closedSquare overlap, so they cannot share a MultiPolygon.
  const model = zoneBlockingModel([square, far, closedSquare]);
  assert.equal(model.priority.length, 2);
  assert.deepEqual(model.priority[1], { if: 'in_zones_1', multiply_by: '0' });
  const first = model.areas.features[0] as { geometry: { type: string; coordinates: unknown[] } };
  assert.equal(first.geometry.type, 'MultiPolygon');
  assert.equal(first.geometry.coordinates.length, 2);
  assert.equal(closedRings(square)[0].length, 5);
});

check('speed limits: sign, estimate and urban default are told apart and merged', () => {
  const segments = toSpeedLimits(
    [[0, 10, 50], [10, 20, 50], [20, 30, null], [30, 40, null], [40, 50, 90]],
    [[0, 10, false], [10, 20, true], [20, 50, false]],
    [[0, 30, 'city'], [30, 40, 'rural'], [40, 50, 'rural']],
  );
  assert.deepEqual(segments, [
    { fromIndex: 0, toIndex: 10, kmh: 50, source: 'sign', urban: true },
    { fromIndex: 10, toIndex: 20, kmh: 50, source: 'estimated', urban: true },
    { fromIndex: 20, toIndex: 30, kmh: 50, source: 'urban_default', urban: true },
    { fromIndex: 30, toIndex: 40, kmh: null, source: 'estimated' },
    { fromIndex: 40, toIndex: 50, kmh: 90, source: 'sign' },
  ]);
});
check('speed limits: absent detail gives no segments; infinity is unknown', () => {
  assert.equal(toSpeedLimits(undefined, undefined, undefined), undefined);
  assert.deepEqual(toSpeedLimits([[0, 5, Infinity as unknown as number]], undefined, undefined), [
    { fromIndex: 0, toIndex: 5, kmh: null, source: 'estimated' },
  ]);
});
check('way ids drop empty stretches', () => {
  assert.deepEqual(toWayIds([[0, 3, 11], [3, 4, null], [4, 9, 12]]), [[0, 3, 11], [4, 9, 12]]);
});

check('turn lanes parse left to right with none for blanks', () => {
  assert.deepEqual(parseTurnLanes('left|through;right||right'), [
    ['left'],
    ['through', 'right'],
    ['none'],
    ['right'],
  ]);
});
check('lanes: a left turn marks only the left lanes', () => {
  assert.deepEqual(lanesForAction('turn_left', parseTurnLanes('left|left;through|through|right')), [
    { indications: ['left'], valid: true },
    { indications: ['left', 'through'], valid: true },
    { indications: ['through'], valid: false },
    { indications: ['right'], valid: false },
  ]);
});
check('lanes: nothing when every lane or no lane serves the turn', () => {
  assert.equal(lanesForAction('turn_right', parseTurnLanes('left|through')), undefined);
  assert.equal(lanesForAction('continue', parseTurnLanes('through|through')), undefined);
  assert.equal(lanesForAction('turn_left', parseTurnLanes('left')), undefined);
  assert.equal(lanesForAction('arrive', parseTurnLanes('left|right')), undefined);
});
check('lanes: tag choice follows one-way and drawing direction', () => {
  const twoWay = { turnLanes: 'x', turnLanesForward: 'f', turnLanesBackward: 'b', oneway: null };
  assert.equal(turnLanesFor(twoWay, true), 'f');
  assert.equal(turnLanesFor(twoWay, false), 'b');
  const oneWay = { turnLanes: 'x', turnLanesForward: null, turnLanesBackward: null, oneway: 'yes' };
  assert.equal(turnLanesFor(oneWay, true), 'x');
  assert.equal(turnLanesFor(oneWay, false), null);
});

check('bearing and angles', () => {
  assert.ok(Math.abs(bearing([35, 32], [35, 32.01])) < 0.5);
  assert.ok(Math.abs(bearing([35, 32], [35.01, 32]) - 90) < 0.5);
  assert.equal(angleBetween(350, 10), 20);
});
check('OSM parsers', () => {
  assert.equal(parseMaxSpeed('50'), 50);
  assert.equal(parseMaxSpeed('30 mph'), 48);
  assert.equal(parseMaxSpeed('signals'), null);
  assert.equal(parseDirection('270'), 270);
  assert.equal(parseDirection('NE'), 45);
  assert.equal(parseDirection('forward'), null);
});
check('roundabout exit is spoken after entering', () => {
  const keys = buildVoiceKeys(
    {
      instruction: 'x',
      action: 'roundabout_enter',
      point: { lat: 32, lng: 35 },
      geometryIndex: 3,
      street: null,
      exitNumber: 3,
    },
    200,
  );
  assert.deepEqual(keys.slice(-2), ['action.roundabout_enter', 'exit.3']);
});

check('deviation: grid search matches the exact distance and stops early with a limit', () => {
  // Two parallel east-west lines about 111 m apart (0.001 degrees of latitude), 10 km long.
  const a = { type: 'LineString' as const, coordinates: [] as [number, number][] };
  const b = { type: 'LineString' as const, coordinates: [] as [number, number][] };
  for (let i = 0; i <= 100; i++) {
    a.coordinates.push([34.8 + i * 0.001, 32]);
    b.coordinates.push([34.8 + i * 0.001, 32.001]);
  }
  const exact = maxDeviationMeters(a, b);
  assert.ok(Math.abs(exact - 110.6) < 1, `got ${exact}`);
  assert.equal(maxDeviationMeters(a, a), 0);
  assert.ok(maxDeviationMeters(a, b, 80) > 80);
  // A detour 2 km off the reference is found even though it is many grid cells away.
  const detour = { type: 'LineString' as const, coordinates: [[34.85, 32.018]] as [number, number][] };
  assert.ok(Math.abs(maxDeviationMeters(a, detour) - 1990) < 15, `got ${maxDeviationMeters(a, detour)}`);
});

process.stdout.write(`\n${passed} passed - PASS\n`);
