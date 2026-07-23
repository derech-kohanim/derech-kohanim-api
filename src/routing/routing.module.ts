import { Module } from '@nestjs/common';

import { ZonesModule } from '../zones/zones.module';
import { GoogleProvider } from './providers/google.provider';
import { GraphHopperProvider } from './providers/graphhopper.provider';
import { HereProvider } from './providers/here.provider';
import { HybridProvider } from './providers/hybrid.provider';
import { MockProvider } from './providers/mock.provider';
import { ProviderRegistry } from './providers/provider-registry';
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
  ],
  exports: [RoutingService, ProviderRegistry],
})
export class RoutingModule {}
