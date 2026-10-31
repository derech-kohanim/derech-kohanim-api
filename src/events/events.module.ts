import { Module } from '@nestjs/common';

import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { RoadAlertsService } from './road-alerts.service';

@Module({
  controllers: [EventsController],
  providers: [EventsService, RoadAlertsService],
})
export class EventsModule {}
