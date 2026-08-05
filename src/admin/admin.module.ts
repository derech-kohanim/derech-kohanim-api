import { Module } from '@nestjs/common';

import { AccountModule } from '../account/account.module';
import { RetentionModule } from '../retention/retention.module';
import { RoutingModule } from '../routing/routing.module';
import { VoiceModule } from '../voice/voice.module';
import { ZonesModule } from '../zones/zones.module';
import { AdminDeletionsController } from './admin-deletions.controller';
import { AdminNavController } from './admin-nav.controller';
import { AdminNavService } from './admin-nav.service';
import { AdminPolygonsController } from './admin-polygons.controller';
import { AdminRoutesController } from './admin-routes.controller';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';
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
  imports: [VoiceModule, RoutingModule, ZonesModule, RetentionModule, AccountModule],
  controllers: [
    AdminController,
    AdminVoiceController,
    AdminNavController,
    AdminRoutesController,
    AdminPolygonsController,
    AdminUsersController,
    AdminDeletionsController,
  ],
  providers: [AdminGuard, AdminService, AdminNavService, AdminUsersService],
})
export class AdminModule {}
