import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { LANGUAGES, LatLngDto } from '../common/dto';
import type { Language, PlaceCategory } from '@shared';

const CATEGORIES: PlaceCategory[] = [
  'address',
  'city',
  'poi',
  'synagogue',
  'coordinates',
  'home',
  'work',
  'other',
];

export class PlaceSearchQueryDto {
  @ApiProperty({ description: 'Raw text the user typed', example: 'רבי עקיבא בני ברק' })
  @IsString()
  @MaxLength(200)
  query: string;

  @ApiPropertyOptional({ enum: LANGUAGES, default: 'he' })
  @IsOptional()
  @IsIn(LANGUAGES)
  language?: Language;

  @ApiPropertyOptional({ description: 'Latitude of the search origin, biases and sorts' })
  @IsOptional()
  @Type(() => Number)
  lat?: number;

  @ApiPropertyOptional({ description: 'Longitude of the search origin' })
  @IsOptional()
  @Type(() => Number)
  lng?: number;

  @ApiPropertyOptional({ description: 'Kept stable while the user types one destination' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  sessionToken?: string;

  @ApiPropertyOptional({ default: 8, minimum: 1, maximum: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(25)
  limit?: number;
}

export class PlaceDetailsQueryDto {
  @ApiProperty({ description: 'Suggestion id, e.g. "geo:ChIJ..." or "saved:<uuid>"' })
  @IsString()
  @IsNotEmpty()
  id: string;

  @ApiPropertyOptional({ enum: LANGUAGES, default: 'he' })
  @IsOptional()
  @IsIn(LANGUAGES)
  language?: Language;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sessionToken?: string;
}

export class SavePlaceDto {
  @ApiProperty({ example: 'בית' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  label: string;

  @ApiPropertyOptional({ enum: CATEGORIES, default: 'other' })
  @IsOptional()
  @IsIn(CATEGORIES)
  category?: PlaceCategory;

  @ApiProperty({ type: LatLngDto })
  @ValidateNested()
  @Type(() => LatLngDto)
  location: LatLngDto;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;
}

export class UpdateSavedPlaceDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;

  @ApiPropertyOptional({ enum: CATEGORIES })
  @IsOptional()
  @IsIn(CATEGORIES)
  category?: PlaceCategory;

  @ApiPropertyOptional({ type: LatLngDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => LatLngDto)
  location?: LatLngDto;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;
}

export class RecordRecentDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  subtitle?: string;

  @ApiProperty({ type: LatLngDto })
  @ValidateNested()
  @Type(() => LatLngDto)
  location: LatLngDto;

  @ApiPropertyOptional({ description: 'Stable upstream identifier, when there is one' })
  @IsOptional()
  @IsString()
  externalId?: string;
}
