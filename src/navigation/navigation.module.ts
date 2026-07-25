import { Module } from '@nestjs/common';

import { RoutingModule } from '../routing/routing.module';
import { ZonesModule } from '../zones/zones.module';
import { FeedbackController } from './feedback.controller';
import { NavigationController } from './navigation.controller';
import { NavigationService } from './navigation.service';

@Module({
  imports: [RoutingModule, ZonesModule],
  controllers: [NavigationController, FeedbackController],
  providers: [NavigationService],
})
export class NavigationModule {}
