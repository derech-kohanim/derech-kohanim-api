import 'dotenv/config';

import { createHash } from 'node:crypto';

import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

import { config } from '../config';
import { runMigrations, waitForDatabase } from '../db/migrate';
import { DEFAULT_PREFERENCES } from '../users/user.mapper';
import { CLIP_CATALOGUE, SEED_VOICE_PACKS } from '../voice/clip-catalogue';
import { DEMO_ZONES } from '../zones/seed/demo-zones';
import { TERMS_DOCUMENTS, TERMS_VERSION } from './terms';

const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD ?? 'derech1234';

/**
 * Idempotent seed: demo zones, the terms document, a demo user and the voice clip
 * catalogue. Safe to run repeatedly, and run automatically on boot when SEED_ON_BOOT is on.
 */
export async function runSeed(prisma: PrismaClient, pool: Pool): Promise<void> {
  await seedZones(pool);
  await seedTerms(prisma);
  await seedDemoUser(prisma);
  await seedVoice(prisma);
}

async function seedZones(pool: Pool): Promise<void> {
  // Bumping the layer version tells every client to re-download, so it must only happen
  // when the geometry actually changed - not on every boot.
  const fingerprint = createHash('sha1')
    .update(JSON.stringify(DEMO_ZONES))
    .digest('hex');
  const { rows } = await pool.query<{ name: string; stringency: string; geojson: string }>(
    `SELECT z.name, l.stringency, ST_AsGeoJSON(z.geom) AS geojson
       FROM zones z JOIN zone_layers l ON l.id = z.layer_id
      WHERE z.source = 'seed'
      ORDER BY z.id`,
  );
  const current = createHash('sha1')
    .update(
      JSON.stringify(
        DEMO_ZONES.map((zone) => ({
          name: zone.name,
          stringency: zone.stringency,
          geojson: JSON.stringify(zone.geometry),
        })),
      ),
    )
    .digest('hex');
  const stored = createHash('sha1')
    .update(
      JSON.stringify(
        rows.map((row) => ({
          name: row.name,
          stringency: row.stringency,
          geojson: JSON.stringify(JSON.parse(row.geojson)),
        })),
      ),
    )
    .digest('hex');

  if (rows.length > 0 && current === stored) {
    console.log(`Demo zones already up to date (${fingerprint.slice(0, 8)})`);
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM zones WHERE source = 'seed'`);

    for (const zone of DEMO_ZONES) {
      await client.query(
        `INSERT INTO zones (layer_id, name, name_he, source, geom)
         VALUES (
           (SELECT id FROM zone_layers WHERE stringency = $1),
           $2, $3, 'seed',
           ST_SetSRID(ST_GeomFromGeoJSON($4), 4326)
         )`,
        [zone.stringency, zone.name, zone.nameHe, JSON.stringify(zone.geometry)],
      );
    }

    // Bumping the version is what tells a client there is something new to download.
    await client.query('UPDATE zone_layers SET version = version + 1, updated_at = now()');
    await client.query('COMMIT');
    console.log(`Seeded ${DEMO_ZONES.length} demo zones`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function seedTerms(prisma: PrismaClient): Promise<void> {
  await prisma.termsDocument.updateMany({ data: { isCurrent: false } });

  for (const document of TERMS_DOCUMENTS) {
    await prisma.termsDocument.upsert({
      where: {
        version_language: { version: TERMS_VERSION, language: document.language },
      },
      create: {
        version: TERMS_VERSION,
        language: document.language,
        title: document.title,
        body: document.body,
        isCurrent: true,
      },
      update: {
        title: document.title,
        body: document.body,
        isCurrent: true,
        updatedAt: new Date(),
      },
    });
  }
  console.log(`Seeded terms version ${TERMS_VERSION}`);
}

async function seedDemoUser(prisma: PrismaClient): Promise<void> {
  const email = config.devLoginEmail;
  const passwordHash = await argonHash(DEMO_PASSWORD);

  const user = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      passwordHash,
      displayName: 'Demo user',
      tier: 'verified',
      providers: ['password'],
      preferences: DEFAULT_PREFERENCES as unknown as object,
      acceptedTermsVersion: TERMS_VERSION,
      acceptedTermsAt: new Date(),
    },
    update: { passwordHash, acceptedTermsVersion: TERMS_VERSION },
  });

  // Two saved places so place search has something personal to return out of the box.
  const savedPlaces = [
    { label: 'בית', category: 'home', lat: 32.0771, lng: 34.8256, address: 'רמת גן' },
    {
      label: 'עבודה',
      category: 'work',
      lat: 32.0935,
      lng: 34.8372,
      address: 'בני ברק',
    },
  ];

  for (const place of savedPlaces) {
    const existing = await prisma.savedPlace.findFirst({
      where: { userId: user.id, label: place.label },
    });
    if (existing) continue;
    await prisma.savedPlace.create({ data: { userId: user.id, ...place } });
  }

  console.log(`Seeded demo user ${email} (password: ${DEMO_PASSWORD})`);
}

async function seedVoice(prisma: PrismaClient): Promise<void> {
  for (const pack of SEED_VOICE_PACKS) {
    await prisma.voicePack.upsert({
      where: { id: pack.id },
      create: { id: pack.id, language: pack.language, voiceId: pack.voiceId, version: 1 },
      // voiceId is set on update too, so a database seeded before the identifier alignment is
      // corrected in place rather than left with the old value.
      update: { voiceId: pack.voiceId, updatedAt: new Date() },
    });

    for (const entry of CLIP_CATALOGUE) {
      const text = entry.text[pack.language];
      const hash = createHash('sha1').update(`${entry.key}|${text}`).digest('hex');

      await prisma.voiceClip.upsert({
        where: { packId_clipKey: { packId: pack.id, clipKey: entry.key } },
        create: {
          packId: pack.id,
          clipKey: entry.key,
          role: entry.role,
          text,
          audioPath: `${pack.id}/clips/${entry.key}.opus`,
          source: 'recorded',
          durationMs: entry.durationMs,
          hash,
        },
        update: { text, durationMs: entry.durationMs, hash },
      });
    }
    console.log(`Seeded voice pack ${pack.id} with ${CLIP_CATALOGUE.length} clips`);
  }
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: config.databaseUrl, max: 2 });
  const prisma = new PrismaClient();
  try {
    await waitForDatabase(pool);
    await runMigrations(pool);
    await runSeed(prisma, pool);
    console.log('Seed complete');
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
