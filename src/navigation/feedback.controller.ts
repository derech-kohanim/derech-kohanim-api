import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUserId, OptionalAuthGuard } from '../auth/auth.guard';
import { NavFeedbackDto } from './navigation.dto';
import { NavigationService } from './navigation.service';
import type { NavFeedback } from '@shared';

@ApiTags('navigation')
@ApiBearerAuth()
@UseGuards(OptionalAuthGuard)
@Controller('api/nav/feedback')
export class FeedbackController {
  constructor(private readonly navigation: NavigationService) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Submit end-of-trip feedback for a route',
    description:
      'Guests may submit anonymously; a signed-in driver has the feedback associated with ' +
      'their account. Text is the optional free-text description, typically on a bad rating.',
  })
  async create(
    @Body() body: NavFeedbackDto,
    @CurrentUserId() userId: string | null,
  ): Promise<NavFeedback> {
    return this.navigation.createFeedback(userId, body);
  }
}
