import { Module } from '@nestjs/common';

import { DangerZonesService } from './danger-zones.service';
import { ZonesController } from './zones.controller';
import { ZonesService } from './zones.service';

@Module({
  controllers: [ZonesController],
  providers: [ZonesService, DangerZonesService],
  exports: [ZonesService, DangerZonesService],
})
export class ZonesModule {}
