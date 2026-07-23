import { Module } from '@nestjs/common';

import { config } from '../config';
import { GoogleTtsService, OfflineTtsService, TtsService } from './tts.service';
import { VoiceController } from './voice.controller';
import { VoiceService } from './voice.service';

@Module({
  controllers: [VoiceController],
  providers: [
    VoiceService,
    // Real Google Cloud TTS by default; the offline tone synthesizer only when asked for,
    // so the store-and-serve pipeline is verifiable without a paid, enabled API.
    {
      provide: TtsService,
      useClass: config.ttsProvider === 'offline' ? OfflineTtsService : GoogleTtsService,
    },
  ],
  exports: [VoiceService],
})
export class VoiceModule {}
