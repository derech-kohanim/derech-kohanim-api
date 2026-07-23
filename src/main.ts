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

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.useGlobalFilters(new ApiErrorFilter());
  app.enableCors({
    origin: config.corsOrigins.includes('*') ? true : config.corsOrigins,
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
