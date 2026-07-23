import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

import { LatLngDto } from '../common/dto';

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

export class EndSessionDto {
  @ApiPropertyOptional({
    default: false,
    description: 'True when the driver actually reached the destination',
  })
  @IsOptional()
  @IsBoolean()
  arrived?: boolean;
}
