import 'dotenv/config';

import { createHash } from 'node:crypto';

import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

import { config } from '../config';
import { runMigrations, waitForDatabase } from '../db/migrate';
import { DEFAULT_PREFERENCES } from '../users/user.mapper';
import {
  CLIP_CATALOGUE,
  LEGACY_HEBREW_VOICE_ID,
  SEED_VOICE_PACKS,
  clipText,
} from '../voice/clip-catalogue';
import { TERMS_DOCUMENTS, TERMS_VERSION } from './terms';

const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD ?? 'derech1234';

/**
 * Idempotent seed: the terms document, a demo user and the voice clip catalogue. Safe to run
 * repeatedly, and run automatically on boot when SEED_ON_BOOT is on.
 *
 * Zone data is NOT seeded here: the real halachic zones and danger zones come from
 * `npm run import:areas`, so a fresh boot contains no demo zones.
 */
export async function runSeed(prisma: PrismaClient, pool: Pool): Promise<void> {
  await seedTerms(prisma);
  await seedDemoUser(prisma);
  await seedVoice(prisma);
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
  // The single Hebrew pack predates the voice choice. Its id now resolves to he-male, so the
  // row (and its clips, by cascade) is only stale data that would show up in the admin list.
  await prisma.voicePack.deleteMany({ where: { id: LEGACY_HEBREW_VOICE_ID } });

  for (const pack of SEED_VOICE_PACKS) {
    await prisma.voicePack.upsert({
      where: { id: pack.id },
      create: { id: pack.id, language: pack.language, voiceId: pack.voiceId, version: 1 },
      // voiceId is set on update too, so a database seeded before the identifier alignment is
      // corrected in place rather than left with the old value.
      update: { voiceId: pack.voiceId, updatedAt: new Date() },
    });

    const existing = new Map(
      (await prisma.voiceClip.findMany({ where: { packId: pack.id } })).map((clip) => [
        clip.clipKey,
        clip,
      ]),
    );

    let changed = 0;
    for (const entry of CLIP_CATALOGUE) {
      const text = clipText(entry, pack.language, pack.voiceId);
      const hash = createHash('sha1').update(`${entry.key}|${text}`).digest('hex');
      const current = existing.get(entry.key);

      if (!current) {
        await prisma.voiceClip.create({
          data: {
            packId: pack.id,
            clipKey: entry.key,
            role: entry.role,
            text,
            audioPath: `${pack.id}/clips/${entry.key}.opus`,
            source: 'recorded',
            durationMs: entry.durationMs,
            hash,
          },
        });
        changed += 1;
        continue;
      }

      if (current.text === text) continue;

      // The wording changed, so the stored audio speaks the old text. Drop it: the clip goes
      // back to a placeholder, pre-generation fills it with the new text, and the new hash
      // tells devices to download it again.
      await prisma.voiceClip.update({
        where: { id: current.id },
        data: {
          role: entry.role,
          text,
          durationMs: entry.durationMs,
          hash,
          source: 'recorded',
          audio: null,
          contentType: null,
        },
      });
      changed += 1;
    }

    if (changed > 0) {
      await prisma.voicePack.update({
        where: { id: pack.id },
        data: { version: { increment: 1 }, updatedAt: new Date() },
      });
    }
    console.log(
      `Seeded voice pack ${pack.id}: ${CLIP_CATALOGUE.length} clips, ${changed} new or changed`,
    );
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
