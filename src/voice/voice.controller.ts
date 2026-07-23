import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { Response } from 'express';

import { AppException } from '../common/app-exception';
import { LANGUAGES } from '../common/dto';
import { VoiceService } from './voice.service';
import type { Language, VoicePackManifest, VoiceResolveResponse } from '@shared';

export class VoiceResolveDto {
  @ApiProperty({ enum: LANGUAGES })
  @IsIn(LANGUAGES)
  language: Language;

  @ApiPropertyOptional({ default: 'default' })
  @IsOptional()
  @IsString()
  voiceId?: string;

  @ApiProperty({ type: [String], example: ['prefix.in', 'dist.200m', 'action.turn_right'] })
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  keys: string[];
}

@ApiTags('voice')
@Controller('api/voice')
export class VoiceController {
  constructor(private readonly voice: VoiceService) {}

  @Get('packs')
  @ApiOperation({
    summary: 'Voice pack manifest',
    description:
      'Without language, lists every pack and its version. With language, returns the ' +
      'manifest; pass sinceVersion to get the version only when nothing changed.',
  })
  @ApiQuery({ name: 'language', enum: LANGUAGES, required: false })
  @ApiQuery({ name: 'voice', required: false })
  @ApiQuery({ name: 'sinceVersion', type: Number, required: false })
  async packs(
    @Query('language') language?: string,
    @Query('voice') voice = 'default',
    @Query('sinceVersion') sinceVersion?: string,
  ): Promise<VoicePackManifest | { packs: unknown[] }> {
    if (!language) {
      return { packs: await this.voice.listPacks() };
    }
    if (!(LANGUAGES as string[]).includes(language)) {
      throw AppException.badRequest(
        'invalid_language',
        `language must be one of: ${LANGUAGES.join(', ')}`,
      );
    }
    const since = sinceVersion === undefined ? undefined : Number(sinceVersion);
    return this.voice.getPack(language as Language, voice, since);
  }

  @Post('clips/resolve')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Return the clips a route needs, generating whatever is missing',
    description:
      'Keys that cannot be produced come back in `missing`. Navigation never waits for ' +
      'audio - a missing clip shortens the instruction, it does not delay it.',
  })
  async resolve(@Body() body: VoiceResolveDto): Promise<VoiceResolveResponse> {
    return this.voice.resolve(body.language, body.voiceId ?? 'default', body.keys);
  }

  @Get('clips/:id')
  @ApiOperation({
    summary: 'Download one clip',
    description:
      'Serves the audio bytes with the right content type. Seeded recorded clips carry ' +
      'metadata only, so until they are generated this returns clip_audio_unavailable. ' +
      'Generated clips (POST /clips/resolve with a TTS backend configured) return audio.',
  })
  async clip(@Param('id') id: string, @Res() response: Response): Promise<void> {
    const clip = await this.voice.getClipAudio(id);
    if (!clip) {
      throw AppException.notFound(
        'clip_audio_unavailable',
        'This clip has no audio yet. Resolve it with a TTS backend configured to generate it.',
      );
    }
    response.setHeader('Content-Type', clip.contentType);
    response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    response.send(clip.audio);
  }
}
