import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsLatitude, IsLongitude, IsNumber } from 'class-validator';

import type { Language, Stringency, TravelMode } from '@shared';

export const LANGUAGES: Language[] = ['he', 'en'];
export const STRINGENCY_VALUES: Stringency[] = ['basic', 'taharat', 'machmirim'];
export const TRAVEL_MODES: TravelMode[] = ['drive', 'walk'];
export const ROUTING_ENGINES = ['here', 'google', 'graphhopper', 'hybrid', 'mock'];

export class LatLngDto {
  @ApiProperty({ example: 32.0873 })
  @Type(() => Number)
  @IsNumber()
  @IsLatitude()
  lat: number;

  @ApiProperty({ example: 34.8288 })
  @Type(() => Number)
  @IsNumber()
  @IsLongitude()
  lng: number;
}

export class ApiErrorDto {
  @ApiProperty({ description: 'Stable code the client translates', example: 'not_found' })
  code: string;

  @ApiProperty({ description: 'Developer-facing detail, never shown to the user' })
  message: string;

  @ApiPropertyOptional({ type: Object })
  details?: Record<string, unknown>;
}

export class LanguageQueryDto {
  @ApiPropertyOptional({ enum: LANGUAGES, default: 'he' })
  @IsIn(LANGUAGES)
  language: Language = 'he';
}
