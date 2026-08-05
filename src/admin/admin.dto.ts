import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { STRINGENCY_VALUES } from '../common/dto';
import type { DeletionRequestStatus, GeoJsonPolygon, Stringency, UserTier } from '@shared';

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

  @ApiPropertyOptional({ description: 'Only sessions belonging to this account' })
  @IsOptional()
  @IsString()
  userId?: string;
}

export class UsersQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Matches email or display name, case-insensitively' })
  @IsOptional()
  @IsString()
  search?: string;
}

const USER_TIERS: UserTier[] = ['guest', 'registered', 'verified'];

/** The only account fields an operator may change from the console. */
export class UpdateUserDto {
  @ApiPropertyOptional({ enum: USER_TIERS })
  @IsOptional()
  @IsIn(USER_TIERS)
  tier?: UserTier;

  @ApiPropertyOptional({ description: 'Empty clears the name' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayName?: string;
}

const DELETION_STATUSES = ['pending', 'completed', 'rejected'] as const;
const DELETION_STATUS_FILTERS = [...DELETION_STATUSES, 'all'] as const;

export class DeletionRequestsQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: DELETION_STATUS_FILTERS, default: 'pending' })
  @IsOptional()
  @IsIn(DELETION_STATUS_FILTERS)
  status: DeletionRequestStatus | 'all' = 'pending';
}

/** The only fields an operator may write on a request; the rest is the audit record. */
export class ResolveDeletionRequestDto {
  @ApiProperty({ enum: DELETION_STATUSES })
  @IsIn(DELETION_STATUSES)
  status: DeletionRequestStatus;

  @ApiPropertyOptional({ description: 'Operator note, e.g. how the requester was verified' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
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
