import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

import { STRINGENCY_VALUES } from '../common/dto';
import type { GeoJsonPolygon, Stringency } from '@shared';

const SESSION_STATUS = ['live', 'ended', 'all'] as const;
type SessionStatusFilter = (typeof SESSION_STATUS)[number];

/** Shared limit/offset paging, defaulting to a sane page size. */
export class PaginationDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit = 50;

  @ApiPropertyOptional({ minimum: 0, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset = 0;
}

export class NavSessionsQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: SESSION_STATUS, default: 'all' })
  @IsOptional()
  @IsIn(SESSION_STATUS)
  status: SessionStatusFilter = 'all';
}

export class UpdateZoneDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  nameHe?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  city?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  street?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string | null;

  @ApiPropertyOptional({ enum: STRINGENCY_VALUES })
  @IsOptional()
  @IsIn(STRINGENCY_VALUES)
  stringency?: Stringency;

  @ApiPropertyOptional({ type: Object, description: 'GeoJSON Polygon geometry' })
  @IsOptional()
  @IsObject()
  geometry?: GeoJsonPolygon;
}

export class UpdateDangerDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  city?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string | null;

  @ApiPropertyOptional({ type: Object, description: 'GeoJSON Polygon geometry' })
  @IsOptional()
  @IsObject()
  geometry?: GeoJsonPolygon;
}
