import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

import { LANGUAGES, STRINGENCY_VALUES } from '../common/dto';
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

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  voiceEnabled?: boolean;

  @ApiPropertyOptional({ example: 'he-default' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  voiceId?: string;
}

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'ישראל ישראלי' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayName?: string;
}
