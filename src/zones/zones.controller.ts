import { Controller, Get, HttpCode, Query, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { AppException } from '../common/app-exception';
import { STRINGENCY_VALUES } from '../common/dto';
import { DangerZonesService } from './danger-zones.service';
import { ZonesService } from './zones.service';
import type { DangerZoneCollection, Stringency, ZoneCollection } from '@shared';

@ApiTags('zones')
@Controller('api')
export class ZonesController {
  constructor(
    private readonly zones: ZonesService,
    private readonly dangerZones: DangerZonesService,
  ) {}

  @Get('zones')
  @ApiOperation({
    summary: 'Forbidden zone layers for a stringency level',
    description:
      'Layers are cumulative: taharat includes basic, machmirim includes both. Each feature ' +
      'carries name, city, street and the full halachic description. Pass sinceVersion to get ' +
      '304 when nothing changed.',
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

  @Get('danger-zones')
  @ApiOperation({
    summary: 'Danger zones (Oslo Area A), a separate axis from halachic stringency',
    description:
      'Each feature carries name, city and description. Pass sinceVersion to get 304 when ' +
      'nothing changed. Avoided by routing when avoidDangerZones is on (the default).',
  })
  @ApiQuery({ name: 'sinceVersion', type: Number, required: false })
  @ApiOkResponse({ description: 'GeoJSON FeatureCollection with a version' })
  async getDangerZones(
    @Res({ passthrough: true }) response: Response,
    @Query('sinceVersion') sinceVersion?: string,
  ): Promise<DangerZoneCollection | undefined> {
    const collection = await this.dangerZones.getCollection();
    if (sinceVersion !== undefined && Number(sinceVersion) >= collection.version) {
      response.status(304);
      return undefined;
    }
    return collection;
  }
}
