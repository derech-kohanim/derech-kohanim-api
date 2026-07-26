import { Module } from '@nestjs/common';

import { RetentionService } from './retention.service';

/** Data lifecycle: the scheduled purge of navigation telemetry past the retention window. */
@Module({
  providers: [RetentionService],
  exports: [RetentionService],
})
export class RetentionModule {}
