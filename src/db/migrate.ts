import { readdirSync, readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { Logger } from '@nestjs/common';
import type { Pool } from 'pg';

const logger = new Logger('Migrate');

/**
 * Plain SQL migrations, applied in filename order and recorded in `schema_migrations`.
 *
 * 001 is generated from the Prisma schema (`npm run prisma:diff`), 002 onwards are the
 * PostGIS tables Prisma cannot describe. Running them here means a cold `docker compose up`
 * or a plain `npm run dev` both reach a working schema with no extra step.
 */
export function migrationsDir(): string {
  const candidates = [join(process.cwd(), 'prisma', 'migrations')];

  // Walk up from the compiled location, so the api works from dist/ too.
  let current = __dirname;
  for (let depth = 0; depth < 6; depth++) {
    candidates.push(join(current, 'prisma', 'migrations'));
    current = dirname(current);
  }

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error('Could not locate prisma/migrations - run from the repository root');
  }
  return resolve(found);
}

/** Retries because the api may briefly outrace Postgres on a cold start. */
export async function waitForDatabase(pool: Pool, attempts = 30): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      if (attempt === attempts) throw error;
      logger.warn(`Database not ready (attempt ${attempt}/${attempts}), retrying in 2s`);
      await new Promise((done) => setTimeout(done, 2000));
    }
  }
}

export async function runMigrations(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )`);

  const dir = migrationsDir();
  const files = readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((row) => row.name));

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = readFileSync(join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      logger.log(`Applied migration ${file}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`);
    } finally {
      client.release();
    }
  }

  logger.log(`Schema ready (${files.length} migration file(s))`);
}
