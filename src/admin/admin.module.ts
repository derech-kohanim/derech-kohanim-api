import { Module } from '@nestjs/common';

import { RoutingModule } from '../routing/routing.module';
import { VoiceModule } from '../voice/voice.module';
import { ZonesModule } from '../zones/zones.module';
import { AdminNavController } from './admin-nav.controller';
import { AdminNavService } from './admin-nav.service';
import { AdminPolygonsController } from './admin-polygons.controller';
import { AdminRoutesController } from './admin-routes.controller';
import { AdminVoiceController } from './admin-voice.controller';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';

/**
 * The admin/ops console API (/api/admin). Every endpoint is gated by JwtAuthGuard + AdminGuard
 * (ADMIN_EMAILS allow-list). It reuses the existing domain services rather than duplicating
 * them: voice, routing (incl. compute-stats), zones and danger zones.
 */
@Module({
  imports: [VoiceModule, RoutingModule, ZonesModule],
  controllers: [
    AdminController,
    AdminVoiceController,
    AdminNavController,
    AdminRoutesController,
    AdminPolygonsController,
  ],
  providers: [AdminGuard, AdminService, AdminNavService],
})
export class AdminModule {}
