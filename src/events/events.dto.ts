import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, ValidateNested } from 'class-validator';

import { LatLngDto } from '../common/dto';
import type { RouteEventType } from '@shared';

/** Types a driver can raise, in the order the picker shows them (REPORT_TYPES). */
export const REPORT_TYPE_VALUES: RouteEventType[] = [
  'police',
  'accident',
  'hazard',
  'closure',
  'traffic',
];

export class CreateReportDto {
  @ApiProperty({ enum: REPORT_TYPE_VALUES, example: 'police' })
  @IsIn(REPORT_TYPE_VALUES)
  type: RouteEventType;

  @ApiProperty({ type: LatLngDto })
  @ValidateNested()
  @Type(() => LatLngDto)
  location: LatLngDto;
}
