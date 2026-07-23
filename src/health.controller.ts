import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { config, resolveProvider } from './config';
import { PrismaService } from './db/prisma.service';

@ApiTags('health')
@Controller('api')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('health')
  @ApiOperation({ summary: 'Liveness, database reachability and the effective engine' })
  async health() {
    let database = 'ok';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      database = `error: ${(error as Error).message}`;
    }

    const provider = resolveProvider();
    return {
      status: database === 'ok' ? 'ok' : 'degraded',
      database,
      provider,
      /** The client shows a warning banner when routing is only simulated. */
      mock: provider === 'mock',
      devLoginEnabled: config.devLoginEnabled,
    };
  }
}
