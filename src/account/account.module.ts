import { Module } from '@nestjs/common';

import { AccountController } from './account.controller';
import { DeletionRequestsService } from './deletion-requests.service';

/**
 * Self-service account administration. Today that is the public deletion-request endpoint
 * behind /delete-account; the service is exported so the admin console can work the same queue.
 */
@Module({
  controllers: [AccountController],
  providers: [DeletionRequestsService],
  exports: [DeletionRequestsService],
})
export class AccountModule {}
