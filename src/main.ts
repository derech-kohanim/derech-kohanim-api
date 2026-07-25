import 'reflect-metadata';
import 'dotenv/config';

import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

import { AppModule } from './app.module';
import { ApiErrorFilter } from './common/api-error.filter';
import { config } from './config';
import { runMigrations, waitForDatabase } from './db/migrate';
import { runSeed } from './seed/seed';
import { VoiceService } from './voice/voice.service';

/**
 * Migrations and seed run before the app is created, so a cold `docker compose up db`
 * followed by `npm run dev` reaches a working system with no extra step.
 */
async function prepareDatabase(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const pool = new Pool({ connectionString: config.databaseUrl, max: 2 });
  const prisma = new PrismaClient();

  try {
    await waitForDatabase(pool);
    if (config.runMigrationsOnBoot) await runMigrations(pool);
    if (config.seedOnBoot) {
      await runSeed(prisma, pool);
      logger.log('Seed data is in place');
    }
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

async function bootstrap(): Promise<void> {
  await prepareDatabase();

  const app = await NestFactory.create(AppModule);

  // Pre-generate the whole global voice pack once, so devices can download a complete pack
  // instead of triggering on-demand generation mid-navigation. Idempotent (skips clips that
  // already have audio) and never blocks or fails boot: a TTS outage is logged and navigation
  // still falls back to shorter spoken instructions.
  try {
    await app.get(VoiceService).pregenerateGlobalPacks();
  } catch (error) {
    new Logger('Bootstrap').warn(
      `Voice pack pre-generation skipped: ${(error as Error).message}`,
    );
  }

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.useGlobalFilters(new ApiErrorFilter());
  // The admin console is served from its own origin; add it alongside the existing ones. A
  // wildcard already allows it, so the admin origin only needs adding to an explicit list.
  const corsOrigins = config.corsOrigins.includes('*')
    ? true
    : [...new Set([...config.corsOrigins, ...(config.adminOrigin ? [config.adminOrigin] : [])])];
  app.enableCors({
    origin: corsOrigins,
    credentials: true,
  });
  app.enableShutdownHooks();

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Derech Kohanim API')
      .setDescription(
        'Navigation backend that avoids halachically forbidden zones. ' +
          'User facing text is always returned as stable codes plus data, never as prose.',
      )
      .setVersion('0.1.0')
      .addBearerAuth()
      .build(),
  );
  SwaggerModule.setup('api/docs', app, document, {
    jsonDocumentUrl: 'api/docs/json',
  });

  await app.listen(config.port, '0.0.0.0');
  new Logger('Bootstrap').log(
    `API on http://0.0.0.0:${config.port} - docs at /api/docs`,
  );
}

void bootstrap();
