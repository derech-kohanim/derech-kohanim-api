import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUserId, OptionalAuthGuard } from '../auth/auth.guard';
import { CreateDeletionRequestDto } from './account.dto';
import { DeletionRequestsService } from './deletion-requests.service';
import type { DeletionRequestReceipt } from '@shared';

@ApiTags('account')
@ApiBearerAuth()
@UseGuards(OptionalAuthGuard)
@Controller('api/account')
export class AccountController {
  constructor(private readonly deletions: DeletionRequestsService) {}

  @Post('deletion-requests')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Ask for an account and its data to be deleted',
    description:
      'Open to anyone, so a user who has already uninstalled the app can still ask. The ' +
      'request is recorded and handled by an operator; nothing is deleted by this call. A ' +
      'signed-in caller has their own address used and the request marked verified. The ' +
      'receipt never reveals whether an account exists for the address, and a second submit ' +
      'for an address with an open request returns that request instead of creating another.',
  })
  async requestDeletion(
    @Body() body: CreateDeletionRequestDto,
    @CurrentUserId() userId: string | null,
  ): Promise<DeletionRequestReceipt> {
    return this.deletions.create(userId, body);
  }
}
