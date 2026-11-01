import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard, RequiredUserId } from '../auth/auth.guard';
import { SupportReportDto } from './support.dto';
import { SupportService } from './support.service';
import type { SupportReportResponse } from '@shared';

@ApiTags('support')
@Controller('api/support')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Post('reports')
  @HttpCode(201)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Send a report or feedback',
    description:
      'Signed-in users only. Files the report as an issue in the private support repository, ' +
      'labelled by kind and platform; a report about a zone that already has an open issue is ' +
      'added to it as a comment. At most five reports per user per hour.',
  })
  async report(
    @RequiredUserId() userId: string,
    @Body() body: SupportReportDto,
  ): Promise<SupportReportResponse> {
    return this.support.report(userId, body);
  }
}
