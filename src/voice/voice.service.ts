import { Injectable, Logger } from '@nestjs/common';

import { AppException } from '../common/app-exception';
import { config } from '../config';
import { PrismaService } from '../db/prisma.service';
import { CLIP_CATALOGUE } from './clip-catalogue';
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
   * Finds the pack for a request, tolerating a voiceId that does not exactly match: it tries
   * the exact voice, then the language default (`<lang>-default`), then any pack for the
   * language. This keeps resolve/pack working when a client sends a voiceId that predates the
   * seeded set, instead of 404ing mid-navigation.
   */
  private async findPack(language: Language, voiceId: string) {
    const byExact = await this.prisma.voicePack.findUnique({
      where: { language_voiceId: { language, voiceId } },
    });
    if (byExact) return byExact;

    const byDefault = await this.prisma.voicePack.findUnique({
      where: { language_voiceId: { language, voiceId: `${language}-default` } },
    });
    if (byDefault) return byDefault;

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
      const text = catalogue?.text[language];
      if (!text || !this.tts.available) {
        missing.push(key);
        continue;
      }

      const generated = await this.tts
        .generate(key, text, language, voiceId)
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
