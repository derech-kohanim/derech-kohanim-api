import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/auth.guard';
import { RouteComputeStatsService } from '../routing/route-compute-stats.service';
import { AdminGuard } from './admin.guard';
import { PaginationDto } from './admin.dto';
import type { AdminRouteCompute, AdminRouteComputeDetail } from './admin.types';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('api/admin/routes')
export class AdminRoutesController {
  constructor(private readonly stats: RouteComputeStatsService) {}

  @Get('computes')
  @ApiOperation({
    summary: 'Route compute timing/debug stats, newest first',
    description:
      'One row per POST /api/routes/compute, capturing provider/route compute time and total ' +
      'server handling time alongside the request parameters and outcome.',
  })
  computes(@Query() query: PaginationDto): Promise<AdminRouteCompute[]> {
    return this.stats.list(query.limit, query.offset);
  }

  @Get('computes/:id')
  @ApiOperation({
    summary: 'One compute stat plus a summary of the stored RoutePlan when available',
  })
  compute(@Param('id') id: string): Promise<AdminRouteComputeDetail> {
    return this.stats.get(id);
  }
}
