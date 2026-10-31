import 'dotenv/config';

import { Pool } from 'pg';

import { config } from '../src/config';
import { waitForDatabase } from '../src/db/migrate';
import {
  bakedModelFileName,
  bakedProfileName,
  bakedZoneHash,
  zoneBlockingModel,
} from '../src/routing/baked-profiles';
import { DangerZonesService } from '../src/zones/danger-zones.service';
import { STRINGENCIES, ZonesService } from '../src/zones/zones.service';

/**
 * Prints the baked-zone GraphHopper profiles as JSON on stdout, for the graph build.
 *
 *   npm run export:graph-models
 *
 * The polygons come from the same services the routing pipeline uses, in the same order, and
 * the names come from the same hash function, so a profile built from this output is exactly
 * the profile the API will ask for (see src/routing/baked-profiles.ts). Nothing else is printed
 * to stdout: the maintainer parses it.
 */
async function main(): Promise<void> {
  const pool = new Pool({ connectionString: config.databaseUrl, max: 2 });
  await waitForDatabase(pool);

  const zones = new ZonesService(pool);
  const danger = new DangerZonesService(pool);
  const dangerPolygons = (await danger.getAvoidZones()).map((zone) => zone.geometry);

  const profiles = [];
  for (const stringency of STRINGENCIES) {
    const halachic = (await zones.getZones(stringency)).map((zone) => zone.geometry);
    const polygons = [...halachic, ...dangerPolygons];
    const hash = bakedZoneHash(polygons);
    profiles.push({
      stringency,
      name: bakedProfileName(stringency, hash),
      hash,
      modelFile: bakedModelFileName(stringency),
      zoneCount: halachic.length,
      dangerCount: dangerPolygons.length,
      customModel: zoneBlockingModel(polygons),
    });
  }

  await pool.end();
  process.stdout.write(JSON.stringify({ generatedAt: new Date().toISOString(), profiles }));
}

main().catch((error) => {
  console.error('export failed:', error);
  process.exit(1);
});
