import 'dotenv/config';

import { readFileSync } from 'node:fs';

import { Pool, type PoolClient } from 'pg';

import { config } from '../src/config';
import { runMigrations, waitForDatabase } from '../src/db/migrate';

/**
 * Replaces the OSM-derived road features with a fresh extract.
 *
 *   npm run import:osm-features -- alerts <file|->
 *   npm run import:osm-features -- lanes <file|->
 *
 * The input is `osmium export -f geojsonseq -a type,id` output (one GeoJSON feature per line,
 * optionally prefixed by the RS character); `-` reads stdin, which is how the maintainer feeds
 * it from the graph volume. Each run replaces its table in one transaction, so a failed import
 * leaves the previous data in place.
 */

interface OsmFeature {
  type: 'Feature';
  geometry: { type: string; coordinates: unknown };
  properties: Record<string, string | undefined>;
}

function readFeatures(source: string): OsmFeature[] {
  const text = source === '-' ? readFileSync(0, 'utf8') : readFileSync(source, 'utf8');
  const features: OsmFeature[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^\u001e/, '').trim();
    if (!line) continue;
    features.push(JSON.parse(line) as OsmFeature);
  }
  return features;
}

function osmId(feature: OsmFeature): number | null {
  const id = Number(feature.properties['@id']);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/** "50", "50 km/h", "30 mph" -> km/h. Anything else is unknown. */
export function parseMaxSpeed(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(km\/h|kmh|mph)?\s*$/i.exec(value);
  if (!match) return null;
  const n = Number(match[1]);
  return Math.round(match[2]?.toLowerCase() === 'mph' ? n * 1.609 : n);
}

/** A camera's facing direction when tagged in degrees (or as a compass point). */
export function parseDirection(value: string | undefined): number | null {
  if (!value) return null;
  const degrees = Number(value);
  if (Number.isFinite(degrees)) return ((degrees % 360) + 360) % 360;
  const compass: Record<string, number> = {
    N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
    S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
  };
  return compass[value.trim().toUpperCase()] ?? null;
}

function isGuarded(props: Record<string, string | undefined>): boolean | null {
  const barrier = props['crossing:barrier'];
  if (barrier) return barrier !== 'no';
  if (props['crossing'] === 'uncontrolled' || props['crossing'] === 'no') return false;
  if (props['crossing:light'] === 'yes' || props['crossing:bell'] === 'yes') return null;
  return null;
}

async function importAlerts(client: PoolClient, features: OsmFeature[]): Promise<string> {
  await client.query('TRUNCATE TABLE road_alerts');
  let cameras = 0;
  let crossings = 0;
  for (const feature of features) {
    const id = osmId(feature);
    if (!id || feature.geometry?.type !== 'Point') continue;
    const props = feature.properties;
    let type: 'speed_camera' | 'rail_crossing' | null = null;
    if (props.highway === 'speed_camera') type = 'speed_camera';
    else if (props.railway === 'level_crossing') type = 'rail_crossing';
    if (!type) continue;

    await client.query(
      `INSERT INTO road_alerts (osm_id, type, max_speed_kmh, direction_deg, guarded, geom)
       VALUES ($1, $2, $3, $4, $5, ST_SetSRID(ST_GeomFromGeoJSON($6), 4326))
       ON CONFLICT DO NOTHING`,
      [
        id,
        type,
        type === 'speed_camera' ? parseMaxSpeed(props.maxspeed) : null,
        type === 'speed_camera' ? parseDirection(props.direction ?? props['camera:direction']) : null,
        type === 'rail_crossing' ? isGuarded(props) : null,
        JSON.stringify(feature.geometry),
      ],
    );
    if (type === 'speed_camera') cameras += 1;
    else crossings += 1;
  }
  return `road_alerts: ${cameras} speed cameras, ${crossings} rail crossings`;
}

async function importLanes(client: PoolClient, features: OsmFeature[]): Promise<string> {
  await client.query('TRUNCATE TABLE osm_turn_lanes');
  let count = 0;
  for (const feature of features) {
    const id = osmId(feature);
    if (!id || feature.geometry?.type !== 'LineString') continue;
    const props = feature.properties;
    if (!props['turn:lanes'] && !props['turn:lanes:forward'] && !props['turn:lanes:backward']) {
      continue;
    }
    await client.query(
      `INSERT INTO osm_turn_lanes
         (way_id, turn_lanes, turn_lanes_forward, turn_lanes_backward, oneway, geom)
       VALUES ($1, $2, $3, $4, $5, ST_SetSRID(ST_GeomFromGeoJSON($6), 4326))
       ON CONFLICT DO NOTHING`,
      [
        id,
        props['turn:lanes'] ?? null,
        props['turn:lanes:forward'] ?? null,
        props['turn:lanes:backward'] ?? null,
        props.oneway ?? (props.junction === 'roundabout' ? 'yes' : null),
        JSON.stringify(feature.geometry),
      ],
    );
    count += 1;
  }
  return `osm_turn_lanes: ${count} ways`;
}

async function main(): Promise<void> {
  const [kind, source] = process.argv.slice(2);
  if ((kind !== 'alerts' && kind !== 'lanes') || !source) {
    throw new Error('usage: import-osm-features <alerts|lanes> <file|->');
  }
  const features = readFeatures(source);

  const pool = new Pool({ connectionString: config.databaseUrl, max: 2 });
  await waitForDatabase(pool);
  await runMigrations(pool);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const summary =
      kind === 'alerts' ? await importAlerts(client, features) : await importLanes(client, features);
    await client.query('COMMIT');
    process.stdout.write(`${summary}\n`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('import failed:', error);
    process.exit(1);
  });
}
