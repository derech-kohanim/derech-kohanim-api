import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AdminGuard } from '../admin/admin.guard';
import { PaginationDto } from '../admin/admin.dto';
import { JwtAuthGuard } from '../auth/auth.guard';
import { PrismaService } from '../db/prisma.service';

/** One user report as the admin console lists it, with a link to its GitHub issue. */
export interface AdminSupportReport {
  id: string;
  kind: string;
  message: string;
  platform: string;
  appVersion: string;
  device: string | null;
  routeId: string | null;
  zoneId: number | null;
  lat: number | null;
  lng: number | null;
  replyByEmail: boolean;
  issueNumber: number | null;
  issueUrl: string | null;
  merged: boolean;
  createdAt: string;
  user: { id: string; email: string | null; displayName: string | null } | null;
}

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('api/admin/support-reports')
export class SupportAdminController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({
    summary: 'User reports and feedback, newest first, with their GitHub issues',
  })
  async list(@Query() query: PaginationDto): Promise<AdminSupportReport[]> {
    const rows = await this.prisma.supportReport.findMany({
      orderBy: { createdAt: 'desc' },
      take: query.limit,
      skip: query.offset,
      include: { user: { select: { id: true, email: true, displayName: true } } },
    });
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      message: row.message,
      platform: row.platform,
      appVersion: row.appVersion,
      device: row.device,
      routeId: row.routeId,
      zoneId: row.zoneId,
      lat: row.lat,
      lng: row.lng,
      replyByEmail: row.replyByEmail,
      issueNumber: row.issueNumber,
      issueUrl: row.issueUrl,
      merged: row.merged,
      createdAt: row.createdAt.toISOString(),
      user: row.user,
    }));
  }
}
