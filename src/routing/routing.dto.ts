import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, ValidateNested } from 'class-validator';

import { LANGUAGES, LatLngDto, ROUTING_ENGINES, STRINGENCY_VALUES, TRAVEL_MODES } from '../common/dto';
import type { Language, RoutingEngine, Stringency, TravelMode } from '@shared';

export class RouteRequestDto {
  @ApiProperty({ type: LatLngDto })
  @ValidateNested()
  @Type(() => LatLngDto)
  origin: LatLngDto;

  @ApiProperty({ type: LatLngDto })
  @ValidateNested()
  @Type(() => LatLngDto)
  destination: LatLngDto;

  @ApiPropertyOptional({ enum: STRINGENCY_VALUES, default: 'basic' })
  @IsOptional()
  @IsIn(STRINGENCY_VALUES)
  stringency?: Stringency;

  @ApiPropertyOptional({ enum: TRAVEL_MODES, default: 'drive' })
  @IsOptional()
  @IsIn(TRAVEL_MODES)
  mode?: TravelMode;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  trafficAware?: boolean;

  @ApiPropertyOptional({ enum: LANGUAGES, default: 'he' })
  @IsOptional()
  @IsIn(LANGUAGES)
  language?: Language;

  @ApiPropertyOptional({
    enum: ROUTING_ENGINES,
    description: 'Omit to use the server default. An engine without credentials is rejected.',
  })
  @IsOptional()
  @IsIn(ROUTING_ENGINES)
  engine?: RoutingEngine;

  @ApiPropertyOptional({
    default: false,
    description: 'Avoid toll roads. Passed to the provider and reflected in each route.',
  })
  @IsOptional()
  @IsBoolean()
  avoidTolls?: boolean;

  @ApiPropertyOptional({
    default: false,
    description:
      'Also return the plain route with no zone avoidance, for comparison. Only filled when ' +
      'avoidance actually changed the outcome.',
  })
  @IsOptional()
  @IsBoolean()
  includeUnavoided?: boolean;
}
