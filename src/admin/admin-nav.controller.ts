import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/auth.guard';
import { AdminNavService } from './admin-nav.service';
import { AdminGuard } from './admin.guard';
import { NavSessionsQueryDto, PaginationDto } from './admin.dto';
import type {
  AdminNavFeedback,
  AdminNavSession,
  AdminNavSessionDetail,
} from './admin.types';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('api/admin/nav')
export class AdminNavController {
  constructor(private readonly nav: AdminNavService) {}

  @Get('sessions')
  @ApiOperation({
    summary: 'List navigation sessions',
    description:
      'Filter by status=live|ended|all. Live means not yet ended. Live data is sparse by ' +
      'design: per-second client reporting was removed.',
  })
  sessions(@Query() query: NavSessionsQueryDto): Promise<AdminNavSession[]> {
    return this.nav.listSessions(query.status, query.limit, query.offset, query.userId);
  }

  @Get('sessions/:id')
  @ApiOperation({
    summary: 'One session with its full route debug picture',
    description:
      'The session, the route it is on, every route the same compute offered (plan), the ' +
      'reroute trail, and the feedback left on those routes.',
  })
  session(@Param('id') id: string): Promise<AdminNavSessionDetail> {
    return this.nav.getSession(id);
  }

  @Get('feedback')
  @ApiOperation({ summary: 'End-of-trip feedback across all routes, newest first' })
  feedback(@Query() query: PaginationDto): Promise<AdminNavFeedback[]> {
    return this.nav.listFeedback(query.limit, query.offset);
  }
}
