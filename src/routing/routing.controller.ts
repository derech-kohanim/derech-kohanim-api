import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUserId, OptionalAuthGuard } from '../auth/auth.guard';
import { AppException } from '../common/app-exception';
import { ProviderRegistry } from './providers/provider-registry';
import { RouteRequestDto } from './routing.dto';
import { RoutingService } from './routing.service';
import type { ProviderInfo, RoutePlan, RouteRequest } from '@shared';

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
    summary: 'Compute a plan of zone-avoiding routes',
    description:
      'Returns a RoutePlan: up to 3 zone-verified alternatives, best first, each labeled ' +
      '(fastest / shortest / alt) and carrying its own id (nav sessions pick one by id). ' +
      'The geometry is always verified server side against the polygons, even when the ' +
      'provider claims native avoidance; a route with verifiedClean=false is for display and ' +
      'diagnosis only and cannot start live navigation. avoidTolls is passed to the provider ' +
      'and reflected in each route avoidsTolls. When includeUnavoided is set and avoidance ' +
      'actually changed the outcome, unavoidedRoute holds the plain route for comparison.',
  })
  async compute(
    @Body() body: RouteRequestDto,
    @CurrentUserId() userId: string | null,
  ): Promise<RoutePlan> {
    const request: RouteRequest = {
      origin: body.origin,
      destination: body.destination,
      stringency: body.stringency ?? 'basic',
      mode: body.mode ?? 'drive',
      trafficAware: body.trafficAware ?? false,
      language: body.language ?? 'he',
      engine: body.engine,
      avoidTolls: body.avoidTolls ?? false,
      avoidDangerZones: body.avoidDangerZones ?? true,
      includeUnavoided: body.includeUnavoided ?? false,
    };

    try {
      return await this.routing.computeAndStorePlan(request, userId);
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
