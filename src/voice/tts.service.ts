import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import { config } from '../config';
import type { Language } from '@shared';

export interface GeneratedClip {
  /** Logical path stored for reference; the bytes themselves live in the database. */
  audioPath: string;
  /** The encoded audio. */
  audio: Buffer;
  contentType: string;
  durationMs: number;
  hash: string;
}

/**
 * The seam for speech generation (spec section 15.6). A clip that does not exist yet is
 * generated once, stored in the pack, and is an ordinary clip from the second user onwards.
 *
 * Whatever implements this must never block navigation: the contract is that a failure or an
 * unavailable backend returns null and the client speaks a shorter instruction.
 */
export abstract class TtsService {
  abstract get available(): boolean;

  abstract generate(
    key: string,
    text: string,
    language: Language,
    voiceId: string,
  ): Promise<GeneratedClip | null>;
}

const TTS_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';

/** Opus in an Ogg container: compact, mono-friendly, the format the packs already use. */
const AUDIO_ENCODING = 'OGG_OPUS';
const CONTENT_TYPE = 'audio/ogg';

interface SynthesizeResponse {
  audioContent?: string;
  error?: { message?: string; status?: string };
}

/**
 * Real Google Cloud Text-to-Speech implementation.
 *
 * When no key is configured it reports itself unavailable and VoiceService takes the
 * documented fallback (report the key missing, never block). When a call fails - the API is
 * not enabled, a network fault - generate returns null for that one key, so a single bad
 * clip shortens an instruction rather than failing the request.
 */
@Injectable()
export class GoogleTtsService extends TtsService {
  private readonly logger = new Logger(GoogleTtsService.name);

  get available(): boolean {
    return Boolean(config.googleTtsApiKey);
  }

  async generate(
    key: string,
    text: string,
    language: Language,
    voiceId: string,
  ): Promise<GeneratedClip | null> {
    if (!this.available) return null;

    try {
      const response = await fetch(`${TTS_URL}?key=${config.googleTtsApiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: { text },
          voice: { languageCode: language === 'en' ? 'en-US' : 'he-IL', ...voiceParams(voiceId) },
          audioConfig: { audioEncoding: AUDIO_ENCODING },
        }),
      });

      const body = (await response.json()) as SynthesizeResponse;
      if (!response.ok || body.error || !body.audioContent) {
        // Passed through to the log verbatim: "API not enabled" reads nothing like "bad key".
        this.logger.warn(
          `Google TTS failed for ${key} (${response.status}): ${
            body.error?.message ?? 'no audio content'
          }`,
        );
        return null;
      }

      const audio = Buffer.from(body.audioContent, 'base64');
      return {
        audioPath: `${language}-${voiceId}/clips/${key}.opus`,
        audio,
        contentType: CONTENT_TYPE,
        durationMs: estimateDurationMs(text),
        hash: createHash('sha1').update(audio).digest('hex'),
      };
    } catch (error) {
      this.logger.warn(`Google TTS error for ${key}: ${(error as Error).message}`);
      return null;
    }
  }
}

/** A named voice picks the gender; the specific voice is left to Google for the locale. */
function voiceParams(voiceId: string): Record<string, string> {
  if (voiceId.includes('female')) return { ssmlGender: 'FEMALE' };
  if (voiceId.includes('male')) return { ssmlGender: 'MALE' };
  return { ssmlGender: 'NEUTRAL' };
}

/** Google does not return a duration, so estimate from the text for announcement scheduling. */
function estimateDurationMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(400, Math.round(words * 380 + 300));
}

/**
 * Offline synthesizer. Produces a valid, short WAV tone rather than real speech, so the
 * generate/store/serve pipeline can be exercised locally and in CI without a paid, enabled
 * speech API. It is NOT a substitute for real voice: the audio is a deterministic beep whose
 * length tracks the text, and it is only selected when TTS_PROVIDER=offline.
 */
@Injectable()
export class OfflineTtsService extends TtsService {
  get available(): boolean {
    return true;
  }

  async generate(
    key: string,
    text: string,
    language: Language,
    voiceId: string,
  ): Promise<GeneratedClip | null> {
    const durationMs = estimateDurationMs(text);
    const audio = synthesizeTone(durationMs);
    return {
      audioPath: `${language}-${voiceId}/clips/${key}.wav`,
      audio,
      contentType: 'audio/wav',
      durationMs,
      hash: createHash('sha1').update(audio).digest('hex'),
    };
  }
}

/** Minimal mono 16-bit PCM WAV holding a quiet sine tone of the given length. */
function synthesizeTone(durationMs: number): Buffer {
  const sampleRate = 16000;
  const samples = Math.round((sampleRate * durationMs) / 1000);
  const dataBytes = samples * 2;

  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);

  const frequency = 440;
  for (let i = 0; i < samples; i++) {
    const value = Math.round(Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 6000);
    buffer.writeInt16LE(value, 44 + i * 2);
  }
  return buffer;
}
