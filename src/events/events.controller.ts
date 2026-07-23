import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard, RequiredUserId } from '../auth/auth.guard';
import { CreateReportDto } from './events.dto';
import { EventsService } from './events.service';
import type { RouteEvent, RouteEventBundle } from '@shared';

@ApiTags('routing')
@Controller('api/routes')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Get(':id/events')
  @ApiOperation({
    summary: 'On-route event feed for a computed route',
    description:
      'Zone events from the route own zone_enter maneuvers, seeded live traffic with the ' +
      'delay it adds, and any user reports raised against this route. Deterministic per ' +
      'route. 404 (route_not_found) if the route id is unknown or expired.',
  })
  async bundle(@Param('id') id: string): Promise<RouteEventBundle> {
    return this.events.getBundle(id);
  }

  @Post(':id/reports')
  @HttpCode(201)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Raise a report against a route',
    description:
      'Stores a community report and returns it as a RouteEvent with reportedByUser=true. ' +
      'It then appears in this route event feed.',
  })
  async report(
    @Param('id') id: string,
    @RequiredUserId() userId: string,
    @Body() body: CreateReportDto,
  ): Promise<RouteEvent> {
    return this.events.createReport(id, userId, {
      routeId: id,
      type: body.type,
      location: body.location,
    });
  }
}
