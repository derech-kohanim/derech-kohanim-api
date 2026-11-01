import { Module } from '@nestjs/common';

import { ZonesModule } from '../zones/zones.module';
import { LanesService } from './lanes.service';
import { GoogleProvider } from './providers/google.provider';
import { GraphHopperProvider } from './providers/graphhopper.provider';
import { HereProvider } from './providers/here.provider';
import { HybridProvider } from './providers/hybrid.provider';
import { MockProvider } from './providers/mock.provider';
import { ProviderRegistry } from './providers/provider-registry';
import { RouteComputeStatsService } from './route-compute-stats.service';
import { RouteComputeTimingInterceptor } from './route-compute-timing.interceptor';
import { RoutingController } from './routing.controller';
import { RoutingService } from './routing.service';

@Module({
  imports: [ZonesModule],
  controllers: [RoutingController],
  providers: [
    HereProvider,
    GoogleProvider,
    GraphHopperProvider,
    HybridProvider,
    MockProvider,
    ProviderRegistry,
    RoutingService,
    LanesService,
    RouteComputeStatsService,
    RouteComputeTimingInterceptor,
  ],
  exports: [RoutingService, ProviderRegistry, RouteComputeStatsService],
})
export class RoutingModule {}
