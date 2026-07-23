import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUserId, OptionalAuthGuard } from '../auth/auth.guard';
import { AppException } from '../common/app-exception';
import { ProviderRegistry } from './providers/provider-registry';
import { RouteRequestDto } from './routing.dto';
import { RoutingService } from './routing.service';
import type { ProviderInfo, RouteRequest, RouteResult } from '@shared';

@ApiTags('routing')
@Controller('api')
export class RoutingController {
  constructor(
    private readonly routing: RoutingService,
    private readonly registry: ProviderRegistry,
  ) {}

  @Post('routes/compute')
  @HttpCode(200)
  @UseGuards(OptionalAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Compute a route that avoids the active forbidden zones',
    description:
      'The geometry is always verified server side against the polygons, even when the ' +
      'provider claims native avoidance. A result with verifiedClean=false is returned for ' +
      'display and diagnosis only and must not start live navigation.',
  })
  async compute(
    @Body() body: RouteRequestDto,
    @CurrentUserId() userId: string | null,
  ): Promise<RouteResult> {
    const request: RouteRequest = {
      origin: body.origin,
      destination: body.destination,
      stringency: body.stringency ?? 'basic',
      mode: body.mode ?? 'drive',
      trafficAware: body.trafficAware ?? false,
      language: body.language ?? 'he',
      engine: body.engine,
    };

    try {
      return await this.routing.computeAndStore(request, userId);
    } catch (error) {
      if (error instanceof AppException) throw error;
      // A provider outage is an upstream failure, not a client error.
      throw AppException.badGateway('routing_failed', (error as Error).message);
    }
  }

  @Get('providers')
  @ApiOperation({
    summary: 'Routing engines this server can actually use',
    description:
      'An engine without credentials is listed but marked unavailable, so the client can ' +
      'show it disabled instead of failing later.',
  })
  providers(): ProviderInfo[] {
    return this.registry.list();
  }
}
