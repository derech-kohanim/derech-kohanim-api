import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/auth.guard';
import { RetentionService } from '../retention/retention.service';
import { AdminEmail, AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';
import type { AdminMe, AdminRetentionResult, AdminSystem } from './admin.types';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('api/admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly retention: RetentionService,
  ) {}

  @Get('me')
  @ApiOperation({
    summary: 'Confirm admin access',
    description:
      'Returns the signed-in admin email once past both the JWT and the ADMIN_EMAILS ' +
      'allow-list. The admin app calls this right after login to verify access.',
  })
  me(@AdminEmail() email: string): AdminMe {
    return { email, isAdmin: true };
  }

  @Get('system')
  @ApiOperation({
    summary: 'System snapshot',
    description: 'Providers, TTS backend, row counts, data versions and process uptime.',
  })
  system(): Promise<AdminSystem> {
    return this.admin.system();
  }

  @Post('retention/sweep')
  @ApiOperation({
    summary: 'Run the retention sweep now',
    description:
      'Deletes navigation sessions, stored routes and compute stats older than RETENTION_DAYS ' +
      '(30 by default). The same sweep runs on a timer; this is for verifying it on demand. ' +
      'End-of-trip feedback is never deleted.',
  })
  sweep(): Promise<AdminRetentionResult> {
    return this.retention.sweep();
  }
}
