import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/auth.guard';
import { AdminEmail, AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';
import type { AdminMe, AdminSystem } from './admin.types';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('api/admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

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
}
