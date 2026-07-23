import { Controller, Get, HttpCode, Query, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { AppException } from '../common/app-exception';
import { STRINGENCY_VALUES } from '../common/dto';
import { ZonesService } from './zones.service';
import type { Stringency, ZoneCollection } from '@shared';

@ApiTags('zones')
@Controller('api/zones')
export class ZonesController {
  constructor(private readonly zones: ZonesService) {}

  @Get()
  @ApiOperation({
    summary: 'Forbidden zone layers for a stringency level',
    description:
      'Layers are cumulative: taharat includes basic, machmirim includes both. ' +
      'Pass sinceVersion to get 304 when nothing changed.',
  })
  @ApiQuery({ name: 'stringency', enum: STRINGENCY_VALUES, required: false })
  @ApiQuery({ name: 'sinceVersion', type: Number, required: false })
  @ApiOkResponse({ description: 'GeoJSON FeatureCollection with a layer version' })
  async getZones(
    @Res({ passthrough: true }) response: Response,
    @Query('stringency') stringency = 'basic',
    @Query('sinceVersion') sinceVersion?: string,
  ): Promise<ZoneCollection | undefined> {
    if (!(STRINGENCY_VALUES as string[]).includes(stringency)) {
      throw AppException.badRequest(
        'invalid_stringency',
        `stringency must be one of: ${STRINGENCY_VALUES.join(', ')}`,
      );
    }

    const collection = await this.zones.getCollection(stringency as Stringency);

    if (sinceVersion !== undefined && Number(sinceVersion) >= collection.version) {
      response.status(304);
      return undefined;
    }
    return collection;
  }
}
