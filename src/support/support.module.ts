import { Module } from '@nestjs/common';

import { AdminGuard } from '../admin/admin.guard';
import { SupportAdminController } from './support-admin.controller';
import { SupportController } from './support.controller';
import { SupportService } from './support.service';

@Module({
  controllers: [SupportController, SupportAdminController],
  providers: [SupportService, AdminGuard],
})
export class SupportModule {}
