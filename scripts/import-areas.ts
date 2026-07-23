import 'dotenv/config';

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Pool } from 'pg';

import { config } from '../src/config';
import { runMigrations, waitForDatabase } from '../src/db/migrate';

/**
 * One-command import that RESETS then loads the real halachic zone data and the danger zones.
 *
 *   npm run import:areas -- <path>      (default ../derech-kohanim-data/areas.json)
 *
 * Level mapping: א -> basic, ב -> taharat, ג -> machmirim into `zones`; "A" -> `danger_zones`.
 * Wipes both tables first, so re-running yields the same result (ids reset, versions are a
 * content hash so identical data keeps the same version).
 */
const DEFAULT_PATH = '../derech-kohanim-data/areas.json';

const LEVEL_TO_STRINGENCY: Record<string, 'basic' | 'taharat' | 'machmirim'> = {
  א: 'basic',
  ב: 'taharat',
  ג: 'machmirim',
};
const DANGER_LEVEL = 'A';

interface RawFeature {
  properties?: {
    name?: string;
    city?: string;
    street?: string;
    description?: string;
    level?: string;
  };
  geometry?: { type?: string; coordinates?: number[][][] };
}

/** A content hash mapped to a positive int, so identical data yields the same version. */
function contentVersion(payload: unknown): number {
  const hash = createHash('sha1').update(JSON.stringify(payload)).digest('hex');
  return parseInt(hash.slice(0, 7), 16);
}

/**
 * Validates and normalises a polygon: every ring must have at least three distinct points and
 * be explicitly closed. Returns the cleaned geometry, or null when the polygon is unusable.
 */
function cleanPolygon(
  geometry: RawFeature['geometry'],
): { type: 'Polygon'; coordinates: number[][][] } | null {
  if (!geometry || geometry.type !== 'Polygon' || !Array.isArray(geometry.coordinates)) {
    return null;
  }
  const rings: number[][][] = [];
  for (const ring of geometry.coordinates) {
    if (!Array.isArray(ring) || ring.length < 3) return null;
    const cleaned = ring.filter(
      (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]),
    );
    if (cleaned.length < 3) return null;

    const first = cleaned[0];
    const last = cleaned[cleaned.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) cleaned.push([first[0], first[1]]);
    if (cleaned.length < 4) return null; // fewer than three distinct corners
    rings.push(cleaned);
  }
  if (rings.length === 0) return null;
  return { type: 'Polygon', coordinates: rings };
}

async function main(): Promise<void> {
  const inputPath = resolve(process.cwd(), process.argv[2] ?? DEFAULT_PATH);
  process.stdout.write(`Importing areas from ${inputPath}\n`);

  let raw = readFileSync(inputPath, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // strip the UTF-8 BOM

  const parsed = JSON.parse(raw) as { data?: { features?: RawFeature[] } };
  const features = parsed.data?.features ?? [];
  if (features.length === 0) throw new Error('No features found under data.features');

  const pool = new Pool({ connectionString: config.databaseUrl, max: 2 });
  await waitForDatabase(pool);
  await runMigrations(pool);

  const summary = {
    basic: 0,
    taharat: 0,
    machmirim: 0,
    danger: 0,
    skipped: 0,
    skippedReasons: {} as Record<string, number>,
  };
  const skip = (reason: string) => {
    summary.skipped += 1;
    summary.skippedReasons[reason] = (summary.skippedReasons[reason] ?? 0) + 1;
  };

  // Group cleaned features so the version can be a hash of the layer's content.
  const stringencyFeatures: Record<'basic' | 'taharat' | 'machmirim', RawFeature[]> = {
    basic: [],
    taharat: [],
    machmirim: [],
  };
  const dangerFeatures: RawFeature[] = [];
  const cleaned = new Map<RawFeature, { type: 'Polygon'; coordinates: number[][][] }>();

  for (const feature of features) {
    const level = feature.properties?.level;
    const geometry = cleanPolygon(feature.geometry);
    if (!geometry) {
      skip('invalid_geometry');
      continue;
    }
    cleaned.set(feature, geometry);

    if (level && level in LEVEL_TO_STRINGENCY) {
      stringencyFeatures[LEVEL_TO_STRINGENCY[level]].push(feature);
    } else if (level === DANGER_LEVEL) {
      dangerFeatures.push(feature);
    } else {
      skip(`unknown_level:${level ?? 'none'}`);
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // RESET: wipe both tables (ids restart so a re-run is byte-for-byte the same).
    await client.query('TRUNCATE TABLE zones RESTART IDENTITY');
    await client.query('TRUNCATE TABLE danger_zones RESTART IDENTITY');

    for (const [stringency, list] of Object.entries(stringencyFeatures)) {
      for (const feature of list) {
        const geometry = cleaned.get(feature)!;
        const props = feature.properties ?? {};
        try {
          await client.query(
            `INSERT INTO zones (layer_id, name, name_he, source, city, street, description, geom)
             VALUES (
               (SELECT id FROM zone_layers WHERE stringency = $1),
               $2, $2, 'import', $3, $4, $5,
               ST_SetSRID(ST_GeomFromGeoJSON($6), 4326)
             )`,
            [
              stringency,
              props.name ?? '',
              props.city || null,
              props.street || null,
              props.description || null,
              JSON.stringify(geometry),
            ],
          );
          summary[stringency as 'basic' | 'taharat' | 'machmirim'] += 1;
        } catch (error) {
          skip(`insert_failed:${(error as Error).message.slice(0, 40)}`);
        }
      }
    }

    const dangerVersion = contentVersion(
      dangerFeatures.map((f) => [f.properties?.name, cleaned.get(f)?.coordinates]),
    );
    for (const feature of dangerFeatures) {
      const geometry = cleaned.get(feature)!;
      const props = feature.properties ?? {};
      try {
        await client.query(
          `INSERT INTO danger_zones (name, city, description, source, version, geom)
           VALUES ($1, $2, $3, 'import', $4, ST_SetSRID(ST_GeomFromGeoJSON($5), 4326))`,
          [
            props.name ?? '',
            props.city || null,
            props.description || null,
            dangerVersion,
            JSON.stringify(geometry),
          ],
        );
        summary.danger += 1;
      } catch (error) {
        skip(`insert_failed:${(error as Error).message.slice(0, 40)}`);
      }
    }

    // Versions are content hashes: identical data keeps the same version, changed data bumps it.
    for (const [stringency, list] of Object.entries(stringencyFeatures)) {
      const version = contentVersion(
        list.map((f) => [f.properties?.name, cleaned.get(f)?.coordinates]),
      );
      await client.query(
        `UPDATE zone_layers SET version = $1, updated_at = now() WHERE stringency = $2`,
        [version, stringency],
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  await pool.end();

  process.stdout.write('\n-------- import summary --------\n');
  process.stdout.write(`zones.basic (א):      ${summary.basic}\n`);
  process.stdout.write(`zones.taharat (ב):    ${summary.taharat}\n`);
  process.stdout.write(`zones.machmirim (ג):  ${summary.machmirim}\n`);
  process.stdout.write(`danger_zones (A):     ${summary.danger}\n`);
  process.stdout.write(`skipped:              ${summary.skipped}\n`);
  for (const [reason, count] of Object.entries(summary.skippedReasons)) {
    process.stdout.write(`  - ${reason}: ${count}\n`);
  }
  const total = summary.basic + summary.taharat + summary.machmirim + summary.danger;
  process.stdout.write(`total imported:       ${total}\n`);
}

main().catch((error) => {
  console.error('import failed:', error);
  process.exit(1);
});
