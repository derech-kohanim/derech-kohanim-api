import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { LatLngDto } from '../common/dto';
import type { NavFeedbackRating } from '@shared';

const FEEDBACK_RATINGS: NavFeedbackRating[] = ['good', 'bad'];

export class CreateSessionDto {
  @ApiProperty({ description: 'Id of a route returned by POST /api/routes/compute' })
  @IsString()
  @IsNotEmpty()
  routeId: string;

  @ApiPropertyOptional({
    default: false,
    description: 'True when positions come from the simulator rather than the device',
  })
  @IsOptional()
  @IsBoolean()
  simulated?: boolean;
}

export class ProgressDto {
  @ApiProperty({ type: LatLngDto })
  @ValidateNested()
  @Type(() => LatLngDto)
  location: LatLngDto;

  @ApiPropertyOptional({ nullable: true, example: 143.5 })
  @IsOptional()
  @IsNumber()
  headingDegrees?: number;

  @ApiPropertyOptional({ nullable: true, example: 13.8 })
  @IsOptional()
  @IsNumber()
  speedMps?: number;

  @ApiPropertyOptional({ description: 'ISO timestamp of the fix' })
  @IsOptional()
  @IsISO8601()
  timestamp?: string;
}

export class NavFeedbackDto {
  @ApiProperty({ description: 'Id of the route the trip was driven on' })
  @IsString()
  @IsNotEmpty()
  routeId: string;

  @ApiProperty({ enum: FEEDBACK_RATINGS, description: 'good or bad' })
  @IsIn(FEEDBACK_RATINGS)
  rating: NavFeedbackRating;

  @ApiPropertyOptional({
    description: 'Optional free-text description, typically supplied on a bad rating',
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  text?: string;
}

export class EndSessionDto {
  @ApiPropertyOptional({
    default: false,
    description: 'True when the driver actually reached the destination',
  })
  @IsOptional()
  @IsBoolean()
  arrived?: boolean;
}
