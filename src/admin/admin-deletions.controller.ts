import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { DeletionRequestsService } from '../account/deletion-requests.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { AppException } from '../common/app-exception';
import { AdminUsersService } from './admin-users.service';
import { AdminEmail, AdminGuard } from './admin.guard';
import { DeletionRequestsQueryDto, ResolveDeletionRequestDto } from './admin.dto';
import type { DeletionRequest } from '@shared';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('api/admin/deletion-requests')
export class AdminDeletionsController {
  constructor(
    private readonly deletions: DeletionRequestsService,
    private readonly users: AdminUsersService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List account deletion requests, newest first',
    description:
      '`status` filters the queue; omit it (or pass "all") for every request. `verified` on a ' +
      'row means the request came from a signed-in session, so the address is proven and the ' +
      'account can be removed without contacting the requester.',
  })
  list(@Query() query: DeletionRequestsQueryDto): Promise<DeletionRequest[]> {
    return this.deletions.list(
      query.status === 'all' ? undefined : query.status,
      query.limit,
      query.offset,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'One deletion request' })
  get(@Param('id') id: string): Promise<DeletionRequest> {
    return this.deletions.get(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Resolve a request, or put it back in the queue',
    description:
      'Only the status and the operator note are writable. This records the decision; it does ' +
      'not delete the account - use POST :id/execute for that.',
  })
  resolve(
    @Param('id') id: string,
    @Body() body: ResolveDeletionRequestDto,
    @AdminEmail() email: string,
  ): Promise<DeletionRequest> {
    return this.deletions.resolve(id, body.status, body.note, email);
  }

  @Post(':id/execute')
  @ApiOperation({
    summary: 'Delete the linked account and complete the request',
    description:
      'Removes the account and its personal data exactly as DELETE /api/admin/users/:id does, ' +
      'then marks this request - and any other pending request for the same account - as ' +
      'completed. Refused when the request is not linked to an account.',
  })
  async execute(@Param('id') id: string, @AdminEmail() email: string): Promise<DeletionRequest> {
    const request = await this.deletions.get(id);
    if (!request.userId) {
      throw AppException.badRequest(
        'deletion_request_unlinked',
        'This request is not linked to an account, so there is nothing to delete',
      );
    }

    await this.users.remove(request.userId, email);
    // The account is gone, so every request waiting on that address is now satisfied.
    await this.deletions.completeForEmail(request.email, email);
    return this.deletions.resolve(id, 'completed', undefined, email);
  }
}
