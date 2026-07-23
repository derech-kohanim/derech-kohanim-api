import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';

import { config } from '../config';
import { PrismaService } from './prisma.service';

/** Raw pg pool, used for the PostGIS geometry Prisma cannot express. */
export const PG_POOL = Symbol('PG_POOL');

@Global()
@Module({
  providers: [
    PrismaService,
    {
      provide: PG_POOL,
      useFactory: () => new Pool({ connectionString: config.databaseUrl, max: 5 }),
    },
  ],
  exports: [PrismaService, PG_POOL],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
