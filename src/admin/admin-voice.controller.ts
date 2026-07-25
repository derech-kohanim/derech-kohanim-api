import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/auth.guard';
import { VoiceService } from '../voice/voice.service';
import { AdminGuard } from './admin.guard';
import type {
  AdminPregenerateSummary,
  AdminVoiceClip,
  AdminVoicePack,
} from './admin.types';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('api/admin/voice')
export class AdminVoiceController {
  constructor(private readonly voice: VoiceService) {}

  @Get('packs')
  @ApiOperation({ summary: 'List voice packs with clip counts and audio byte totals' })
  packs(): Promise<AdminVoicePack[]> {
    return this.voice.adminListPacks();
  }

  @Get('packs/:id/clips')
  @ApiOperation({ summary: 'List the clips of one pack, with audio presence and size' })
  clips(@Param('id') id: string): Promise<AdminVoiceClip[]> {
    return this.voice.adminListClips(id);
  }

  @Post('clips/:id/regenerate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Regenerate one clip via the TTS backend' })
  regenerate(@Param('id') id: string): Promise<AdminVoiceClip> {
    return this.voice.regenerateClip(id);
  }

  @Post('packs/:id/pregenerate')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Generate every missing clip in a pack',
    description: 'Returns a summary of how many clips were generated, skipped and failed.',
  })
  pregenerate(@Param('id') id: string): Promise<AdminPregenerateSummary> {
    return this.voice.adminPregeneratePack(id);
  }

  @Delete('clips/:id')
  @ApiOperation({ summary: 'Remove a clip (row and audio)' })
  remove(@Param('id') id: string): Promise<{ ok: true }> {
    return this.voice.deleteClip(id);
  }
}
