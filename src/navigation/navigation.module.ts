import { Module } from '@nestjs/common';

import { RoutingModule } from '../routing/routing.module';
import { ZonesModule } from '../zones/zones.module';
import { NavigationController } from './navigation.controller';
import { NavigationService } from './navigation.service';

@Module({
  imports: [RoutingModule, ZonesModule],
  controllers: [NavigationController],
  providers: [NavigationService],
})
export class NavigationModule {}
