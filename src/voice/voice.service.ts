import { Injectable, Logger } from '@nestjs/common';

import type {
  AdminPregenerateSummary,
  AdminVoiceClip,
  AdminVoicePack,
} from '../admin/admin.types';
import { AppException } from '../common/app-exception';
import { config } from '../config';
import { PrismaService } from '../db/prisma.service';
import {
  CLIP_CATALOGUE,
  SEED_VOICE_PACKS,
  canonicalVoiceId,
  clipText,
} from './clip-catalogue';
import { TtsService } from './tts.service';
import type {
  Language,
  VoiceClip,
  VoiceClipRole,
  VoiceClipSource,
  VoicePackManifest,
  VoiceResolveResponse,
} from '@shared';

@Injectable()
export class VoiceService {
  private readonly logger = new Logger(VoiceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tts: TtsService,
  ) {}

  /**
   * Finds the pack for a request, tolerating a voiceId that does not exactly match: the id is
   * first mapped onto a seeded voice (the legacy `he-default` and unknown ids land on he-male),
   * then any pack for the language is accepted. This keeps resolve/pack working when a client
   * sends a voiceId that predates the seeded set, instead of 404ing mid-navigation.
   */
  private async findPack(language: Language, voiceId: string) {
    const canonical = canonicalVoiceId(language, voiceId);
    const byCanonical = await this.prisma.voicePack.findUnique({
      where: { language_voiceId: { language, voiceId: canonical } },
    });
    if (byCanonical) return byCanonical;

    return this.prisma.voicePack.findFirst({ where: { language } });
  }

  async getPack(
    language: Language,
    voiceId: string,
    sinceVersion?: number,
  ): Promise<VoicePackManifest> {
    const found = await this.findPack(language, voiceId);
    if (!found) {
      throw AppException.notFound(
        'voice_pack_not_found',
        `No voice pack for language=${language} voice=${voiceId}`,
      );
    }
    const pack = await this.prisma.voicePack.findUnique({
      where: { id: found.id },
      include: { clips: { orderBy: { clipKey: 'asc' } } },
    });
    if (!pack) {
      throw AppException.notFound('voice_pack_not_found', `Voice pack ${found.id} vanished`);
    }

    // The client only needs the clip list when something actually changed.
    const unchanged = sinceVersion !== undefined && sinceVersion >= pack.version;

    return {
      language: pack.language as Language,
      voiceId: pack.voiceId,
      version: pack.version,
      updatedAt: pack.updatedAt.toISOString(),
      clips: unchanged ? [] : pack.clips.map((clip) => toVoiceClip(clip)),
    };
  }

  /**
   * Returns the clips the client asked for, generating whatever is missing.
   *
   * Navigation never waits for audio: anything that cannot be produced comes back in
   * `missing` and the client speaks a shorter instruction instead (spec section 15.6).
   */
  async resolve(
    language: Language,
    voiceId: string,
    keys: string[],
  ): Promise<VoiceResolveResponse> {
    const pack = await this.findPack(language, voiceId);
    if (!pack) {
      throw AppException.notFound(
        'voice_pack_not_found',
        `No voice pack for language=${language} voice=${voiceId}`,
      );
    }

    const wanted = [...new Set(keys)];
    const existing = await this.prisma.voiceClip.findMany({
      where: { packId: pack.id, clipKey: { in: wanted } },
    });

    // A clip is "ready" only when it actually has audio bytes. A seeded recorded row without
    // bytes is a placeholder to be filled by generation, not something the client can play.
    const ready = new Map(
      existing.filter((clip) => clip.audio).map((clip) => [clip.clipKey, clip]),
    );
    const clips: VoiceClip[] = [...ready.values()].map((clip) => toVoiceClip(clip));
    const missing: string[] = [];
    let generatedCount = 0;

    for (const key of wanted) {
      if (ready.has(key)) continue;

      const catalogue = CLIP_CATALOGUE.find((entry) => entry.key === key);
      // Street names are an open vocabulary keyed by hash, so the text is not known from the
      // key alone (spec section 15.5). Only closed-catalogue keys can be generated on resolve.
      // The text and the synthesized voice follow the PACK's voice, not the id the client
      // sent, so a legacy or unknown id still gets the gendered text of the pack it landed on.
      const text = catalogue ? clipText(catalogue, language, pack.voiceId) : undefined;
      if (!text || !this.tts.available) {
        missing.push(key);
        continue;
      }

      const generated = await this.tts
        .generate(key, text, language, pack.voiceId)
        .catch(() => null);
      if (!generated) {
        missing.push(key);
        continue;
      }

      // Fill the placeholder (or create the row) with the produced audio.
      const saved = await this.prisma.voiceClip.upsert({
        where: { packId_clipKey: { packId: pack.id, clipKey: key } },
        create: {
          packId: pack.id,
          clipKey: key,
          role: (catalogue?.role ?? 'misc') as VoiceClipRole,
          text,
          audioPath: generated.audioPath,
          source: 'generated',
          durationMs: generated.durationMs,
          hash: generated.hash,
          audio: new Uint8Array(generated.audio),
          contentType: generated.contentType,
        },
        update: {
          text,
          audioPath: generated.audioPath,
          source: 'generated',
          durationMs: generated.durationMs,
          hash: generated.hash,
          audio: new Uint8Array(generated.audio),
          contentType: generated.contentType,
        },
      });
      generatedCount += 1;
      clips.push(toVoiceClip(saved));
    }

    // One version bump per resolve that produced anything, so a client knows to re-sync.
    if (generatedCount > 0) {
      await this.prisma.voicePack.update({
        where: { id: pack.id },
        data: { version: { increment: 1 }, updatedAt: new Date() },
      });
    }

    return { clips, missing };
  }

  /**
   * Generates and stores audio for every closed-catalogue clip in the global packs
   * (he-male, he-female, en-default), so a device can download a complete pack instead of triggering
   * on-demand generation mid-navigation.
   *
   * Idempotent: clips that already carry audio bytes are skipped, so re-running on every boot
   * does no work once a pack is complete. Never blocks or fails boot - if the TTS backend is
   * unavailable, or a single clip fails, it is logged and left for on-demand resolve, in line
   * with the "voice never blocks navigation" contract.
   */
  async pregenerateGlobalPacks(): Promise<void> {
    if (!this.tts.available) {
      this.logger.log('TTS backend unavailable; skipping voice pack pre-generation');
      return;
    }

    for (const seed of SEED_VOICE_PACKS) {
      try {
        await this.pregeneratePack(seed.language, seed.voiceId);
      } catch (error) {
        this.logger.warn(
          `Voice pack pre-generation failed for ${seed.id}: ${(error as Error).message}`,
        );
      }
    }
  }

  private async pregeneratePack(
    language: Language,
    voiceId: string,
  ): Promise<AdminPregenerateSummary> {
    const pack = await this.findPack(language, voiceId);
    if (!pack) {
      this.logger.warn(`No voice pack for ${language}/${voiceId}; skipping pre-generation`);
      return { generated: 0, skipped: 0, failed: 0 };
    }

    const existing = await this.prisma.voiceClip.findMany({ where: { packId: pack.id } });
    // Only bytes count as "generated": a seeded recorded row without audio is a placeholder.
    const hasAudio = new Set(
      existing.filter((clip) => clip.audio).map((clip) => clip.clipKey),
    );

    let generatedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    for (const entry of CLIP_CATALOGUE) {
      if (hasAudio.has(entry.key)) {
        skippedCount += 1;
        continue;
      }

      const text = clipText(entry, language, pack.voiceId);
      const generated = await this.tts
        .generate(entry.key, text, language, pack.voiceId)
        .catch(() => null);
      if (!generated) {
        failedCount += 1;
        continue;
      }

      await this.prisma.voiceClip.upsert({
        where: { packId_clipKey: { packId: pack.id, clipKey: entry.key } },
        create: {
          packId: pack.id,
          clipKey: entry.key,
          role: entry.role,
          text,
          audioPath: generated.audioPath,
          source: 'generated',
          durationMs: generated.durationMs,
          hash: generated.hash,
          audio: new Uint8Array(generated.audio),
          contentType: generated.contentType,
        },
        update: {
          text,
          audioPath: generated.audioPath,
          source: 'generated',
          durationMs: generated.durationMs,
          hash: generated.hash,
          audio: new Uint8Array(generated.audio),
          contentType: generated.contentType,
        },
      });
      generatedCount += 1;
    }

    if (generatedCount > 0) {
      // One version bump per pack that gained audio, so devices know to re-sync.
      await this.prisma.voicePack.update({
        where: { id: pack.id },
        data: { version: { increment: 1 }, updatedAt: new Date() },
      });
      this.logger.log(
        `Pre-generated ${generatedCount} clip(s) for voice pack ${pack.id}; version bumped`,
      );
    } else {
      this.logger.log(`Voice pack ${pack.id} already complete; nothing to pre-generate`);
    }

    return { generated: generatedCount, skipped: skippedCount, failed: failedCount };
  }

  async listPacks(): Promise<{ id: string; language: Language; voiceId: string; version: number }[]> {
    const packs = await this.prisma.voicePack.findMany({ orderBy: { id: 'asc' } });
    return packs.map((pack) => ({
      id: pack.id,
      language: pack.language as Language,
      voiceId: pack.voiceId,
      version: pack.version,
    }));
  }

  /** The audio bytes for a clip, or null when the clip carries metadata only. */
  async getClipAudio(
    clipId: string,
  ): Promise<{ audio: Buffer; contentType: string } | null> {
    const clip = await this.prisma.voiceClip.findUnique({ where: { id: clipId } });
    if (!clip) throw AppException.notFound('clip_not_found', 'No such voice clip');
    if (!clip.audio) return null;
    return {
      audio: Buffer.from(clip.audio),
      contentType: clip.contentType ?? 'audio/ogg',
    };
  }

  // --- Admin console (/api/admin/voice) --------------------------------------------------

  /** Every pack with per-pack clip counts and audio byte totals, for the admin overview. */
  async adminListPacks(): Promise<AdminVoicePack[]> {
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        language: string;
        voice_id: string;
        version: number;
        updated_at: Date;
        clip_count: number;
        with_audio: number;
        total_bytes: bigint;
      }[]
    >`
      SELECT p.id, p.language, p.voice_id, p.version, p.updated_at,
             count(c.id)::int AS clip_count,
             count(c.audio)::int AS with_audio,
             coalesce(sum(octet_length(c.audio)), 0)::bigint AS total_bytes
        FROM voice_packs p
        LEFT JOIN voice_clips c ON c.pack_id = p.id
       GROUP BY p.id
       ORDER BY p.id`;

    return rows.map((row) => ({
      id: row.id,
      language: row.language,
      voiceId: row.voice_id,
      version: row.version,
      clipCount: row.clip_count,
      withAudio: row.with_audio,
      missingAudio: row.clip_count - row.with_audio,
      totalBytes: Number(row.total_bytes),
      updatedAt: row.updated_at.toISOString(),
    }));
  }

  /** Clips of one pack with audio presence and byte size, for the admin clip table. */
  async adminListClips(packId: string): Promise<AdminVoiceClip[]> {
    const pack = await this.prisma.voicePack.findUnique({ where: { id: packId } });
    if (!pack) throw AppException.notFound('voice_pack_not_found', 'No such voice pack');

    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        clip_key: string;
        role: string;
        text: string;
        source: string;
        hash: string;
        duration_ms: number;
        content_type: string | null;
        has_audio: boolean;
        size_bytes: number;
      }[]
    >`
      SELECT id, clip_key, role, text, source, hash, duration_ms, content_type,
             (audio IS NOT NULL) AS has_audio,
             coalesce(octet_length(audio), 0)::int AS size_bytes
        FROM voice_clips
       WHERE pack_id = ${packId}
       ORDER BY clip_key`;

    return rows.map((row) => this.toAdminClip(row));
  }

  /** Regenerates one clip's audio via the TTS backend and returns the updated clip. */
  async regenerateClip(clipId: string): Promise<AdminVoiceClip> {
    const clip = await this.prisma.voiceClip.findUnique({
      where: { id: clipId },
      include: { pack: true },
    });
    if (!clip) throw AppException.notFound('clip_not_found', 'No such voice clip');
    if (!this.tts.available) {
      throw AppException.badGateway(
        'tts_unavailable',
        'No TTS backend is configured, so audio cannot be generated',
      );
    }

    const generated = await this.tts
      .generate(clip.clipKey, clip.text, clip.pack.language as Language, clip.pack.voiceId)
      .catch(() => null);
    if (!generated) {
      throw AppException.badGateway('tts_failed', `Could not generate audio for ${clip.clipKey}`);
    }

    const saved = await this.prisma.voiceClip.update({
      where: { id: clip.id },
      data: {
        audioPath: generated.audioPath,
        source: 'generated',
        durationMs: generated.durationMs,
        hash: generated.hash,
        audio: new Uint8Array(generated.audio),
        contentType: generated.contentType,
      },
    });
    // A regenerated clip changes the pack, so bump the version to trigger a client re-sync.
    await this.prisma.voicePack.update({
      where: { id: clip.packId },
      data: { version: { increment: 1 }, updatedAt: new Date() },
    });

    return this.toAdminClip({
      id: saved.id,
      clip_key: saved.clipKey,
      role: saved.role,
      text: saved.text,
      source: saved.source,
      hash: saved.hash,
      duration_ms: saved.durationMs,
      content_type: saved.contentType,
      has_audio: Boolean(saved.audio),
      size_bytes: saved.audio ? saved.audio.length : 0,
    });
  }

  /** Generates every missing clip in a pack, returning how many were made/skipped/failed. */
  async adminPregeneratePack(packId: string): Promise<AdminPregenerateSummary> {
    const pack = await this.prisma.voicePack.findUnique({ where: { id: packId } });
    if (!pack) throw AppException.notFound('voice_pack_not_found', 'No such voice pack');
    return this.pregeneratePack(pack.language as Language, pack.voiceId);
  }

  /** Removes a clip entirely (row and its audio), bumping the pack version. */
  async deleteClip(clipId: string): Promise<{ ok: true }> {
    const clip = await this.prisma.voiceClip.findUnique({ where: { id: clipId } });
    if (!clip) throw AppException.notFound('clip_not_found', 'No such voice clip');

    await this.prisma.voiceClip.delete({ where: { id: clipId } });
    await this.prisma.voicePack.update({
      where: { id: clip.packId },
      data: { version: { increment: 1 }, updatedAt: new Date() },
    });
    return { ok: true };
  }

  private toAdminClip(row: {
    id: string;
    clip_key: string;
    role: string;
    text: string;
    source: string;
    hash: string;
    duration_ms: number;
    content_type: string | null;
    has_audio: boolean;
    size_bytes: number;
  }): AdminVoiceClip {
    return {
      id: row.id,
      key: row.clip_key,
      role: row.role,
      text: row.text,
      source: row.source,
      hash: row.hash,
      durationMs: row.duration_ms,
      hasAudio: row.has_audio,
      sizeBytes: row.size_bytes,
      contentType: row.content_type,
      url: `${config.voiceBaseUrl}/${row.id}`,
    };
  }
}

function toVoiceClip(row: {
  id: string;
  clipKey: string;
  role: string;
  text: string;
  audioPath: string;
  source: string;
  durationMs: number;
  hash: string;
}): VoiceClip {
  return {
    key: row.clipKey,
    role: row.role as VoiceClipRole,
    text: row.text,
    url: `${config.voiceBaseUrl}/${row.id}`,
    durationMs: row.durationMs,
    source: row.source as VoiceClipSource,
    hash: row.hash,
  };
}
