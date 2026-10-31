import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

import { LANGUAGES, STRINGENCY_VALUES } from '../common/dto';
import { ACCEPTED_VOICE_IDS } from '../voice/clip-catalogue';
import type { Language, Stringency, ThemePreference } from '@shared';

const THEMES: ThemePreference[] = ['system', 'light', 'dark'];

export class UpdatePreferencesDto {
  @ApiPropertyOptional({ enum: LANGUAGES })
  @IsOptional()
  @IsIn(LANGUAGES)
  language?: Language;

  @ApiPropertyOptional({ enum: THEMES })
  @IsOptional()
  @IsIn(THEMES)
  theme?: ThemePreference;

  @ApiPropertyOptional({ enum: STRINGENCY_VALUES })
  @IsOptional()
  @IsIn(STRINGENCY_VALUES)
  stringency?: Stringency;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  trafficAware?: boolean;

  @ApiPropertyOptional({ description: 'Avoid toll roads by default' })
  @IsOptional()
  @IsBoolean()
  avoidTolls?: boolean;

  @ApiPropertyOptional({ description: 'Avoid danger zones (Area A) by default' })
  @IsOptional()
  @IsBoolean()
  avoidDangerZones?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  voiceEnabled?: boolean;

  @ApiPropertyOptional({
    enum: ACCEPTED_VOICE_IDS,
    example: 'he-female',
    description: 'he-male, he-female or en-default. he-default is accepted as he-male.',
  })
  @IsOptional()
  @IsIn(ACCEPTED_VOICE_IDS)
  voiceId?: string;
}

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'ישראל ישראלי' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayName?: string;
}
