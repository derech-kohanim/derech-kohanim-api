import { Body, Controller, Get, Param, ParseIntPipe, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/auth.guard';
import { DangerZonesService } from '../zones/danger-zones.service';
import { ZonesService } from '../zones/zones.service';
import { AdminGuard } from './admin.guard';
import { UpdateDangerDto, UpdateZoneDto } from './admin.dto';
import type { AdminDangerSummary, AdminZoneSummary } from './admin.types';
import type { DangerZoneFeature, ZoneFeature } from '@shared';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('api/admin/polygons')
export class AdminPolygonsController {
  constructor(
    private readonly zones: ZonesService,
    private readonly dangerZones: DangerZonesService,
  ) {}

  @Get('zones')
  @ApiOperation({ summary: 'List halachic stringency zones with vertex counts and bounding boxes' })
  listZones(): Promise<AdminZoneSummary[]> {
    return this.zones.adminListZones();
  }

  @Get('zones/:id')
  @ApiOperation({ summary: 'One zone as a full GeoJSON Feature' })
  getZone(@Param('id', ParseIntPipe) id: number): Promise<ZoneFeature> {
    return this.zones.adminGetZone(id);
  }

  @Patch('zones/:id')
  @ApiOperation({
    summary: 'Update a zone (properties and/or geometry)',
    description:
      'Partial update. A supplied geometry is validated as a GeoJSON Polygon. Any change bumps ' +
      'the zone data version so clients re-sync.',
  })
  updateZone(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: UpdateZoneDto,
  ): Promise<ZoneFeature> {
    return this.zones.adminUpdateZone(id, body);
  }

  @Get('danger')
  @ApiOperation({ summary: 'List danger zones (Area A) with vertex counts and bounding boxes' })
  listDanger(): Promise<AdminDangerSummary[]> {
    return this.dangerZones.adminListDanger();
  }

  @Get('danger/:id')
  @ApiOperation({ summary: 'One danger zone as a full GeoJSON Feature (raw database id)' })
  getDanger(@Param('id', ParseIntPipe) id: number): Promise<DangerZoneFeature> {
    return this.dangerZones.adminGetDanger(id);
  }

  @Patch('danger/:id')
  @ApiOperation({
    summary: 'Update a danger zone (properties and/or geometry)',
    description:
      'Partial update by raw database id. A supplied geometry is validated as a GeoJSON ' +
      'Polygon. Any change bumps the danger layer version so clients re-sync.',
  })
  updateDanger(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: UpdateDangerDto,
  ): Promise<DangerZoneFeature> {
    return this.dangerZones.adminUpdateDanger(id, body);
  }
}
