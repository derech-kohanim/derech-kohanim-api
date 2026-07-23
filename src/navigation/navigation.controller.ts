import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUserId, OptionalAuthGuard } from '../auth/auth.guard';
import { CreateSessionDto, EndSessionDto, ProgressDto } from './navigation.dto';
import { NavigationService } from './navigation.service';
import type { NavigationProgressResponse, NavigationSession } from '@shared';

@ApiTags('navigation')
@ApiBearerAuth()
@UseGuards(OptionalAuthGuard)
@Controller('api/nav/sessions')
export class NavigationController {
  constructor(private readonly navigation: NavigationService) {}

  @Post()
  @ApiOperation({
    summary: 'Open a live navigation session for a computed route',
    description: 'Rejects a route that was not verified clean.',
  })
  async create(
    @Body() body: CreateSessionDto,
    @CurrentUserId() userId: string | null,
  ): Promise<NavigationSession> {
    return this.navigation.create(userId, body);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Session state' })
  async get(
    @Param('id') id: string,
    @CurrentUserId() userId: string | null,
  ): Promise<NavigationSession> {
    return this.navigation.get(id, userId);
  }

  @Post(':id/progress')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Report a position and get the driving state back',
    description:
      'Returns the current step, distance to it, what is left, any zone alert, and a new ' +
      'route when the driver has left the old one.',
  })
  async progress(
    @Param('id') id: string,
    @Body() body: ProgressDto,
    @CurrentUserId() userId: string | null,
  ): Promise<NavigationProgressResponse> {
    return this.navigation.progress(id, userId, body);
  }

  @Post(':id/end')
  @HttpCode(200)
  @ApiOperation({ summary: 'Close the session' })
  async end(
    @Param('id') id: string,
    @Body() body: EndSessionDto,
    @CurrentUserId() userId: string | null,
  ): Promise<NavigationSession> {
    return this.navigation.end(id, userId, body.arrived ?? false);
  }
}
