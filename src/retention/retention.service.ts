import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { config } from '../config';
import { PrismaService } from '../db/prisma.service';
import type { AdminRetentionResult } from '../admin/admin.types';

/** How long after boot the first sweep runs, so it never competes with startup. */
const FIRST_SWEEP_DELAY_MS = 60_000;

/**
 * Deletes navigation and routing telemetry once it passes the retention window (30 days by
 * default, RETENTION_DAYS). These rows exist to debug route quality, which is a question about
 * recent behaviour; keeping origin/destination pairs indefinitely is a liability, not an asset.
 *
 * What goes:
 *   - nav_sessions older than the window, and their route trail (cascade)
 *   - routes older than the window that no surviving session still points at, and their reports
 *   - route_compute_stats older than the window
 *
 * What stays: end-of-trip feedback. Its route reference is nulled rather than cascaded, so the
 * rating and the driver's description of what went wrong outlive the geometry they were about.
 *
 * Runs on a plain interval rather than a cron dependency: one sweep a day, with the timer
 * unref'd so it can never hold the process open.
 */
@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetentionService.name);
  private timer: NodeJS.Timeout | null = null;
  private firstRun: NodeJS.Timeout | null = null;
  private lastResult: AdminRetentionResult | null = null;
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    if (config.retentionDays <= 0) {
      this.logger.warn('RETENTION_DAYS is 0 - navigation telemetry is kept indefinitely');
      return;
    }

    // At least an hour apart, so a mistyped RETENTION_SWEEP_HOURS cannot turn the sweep into a
    // busy loop against the database.
    const everyHours = Math.max(1, config.retentionSweepHours);

    this.firstRun = setTimeout(() => void this.sweepQuietly(), FIRST_SWEEP_DELAY_MS);
    this.timer = setInterval(() => void this.sweepQuietly(), everyHours * 60 * 60 * 1000);
    this.firstRun.unref?.();
    this.timer.unref?.();

    this.logger.log(
      `Retention: deleting navigation telemetry older than ${config.retentionDays} days, ` +
        `sweeping every ${everyHours}h`,
    );
  }

  onModuleDestroy(): void {
    if (this.firstRun) clearTimeout(this.firstRun);
    if (this.timer) clearInterval(this.timer);
  }

  /** The most recent sweep result, for the admin system snapshot. */
  last(): AdminRetentionResult | null {
    return this.lastResult;
  }

  /** Runs a sweep now. Exposed so an operator can trigger it from the console. */
  async sweep(): Promise<AdminRetentionResult> {
    const days = config.retentionDays;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Sessions first: deleting a route cascades to the sessions on it, so clearing the expired
    // sessions up front keeps the route step from taking a live session with it.
    const sessions = await this.prisma.navSession.deleteMany({
      where: { startedAt: { lt: cutoff } },
    });

    // `navSessions: none` guards the case of a session still running on an older route - rare,
    // but deleting its route mid-drive would end the session by cascade.
    const routes = await this.prisma.route.deleteMany({
      where: { createdAt: { lt: cutoff }, navSessions: { none: {} } },
    });

    const computes = await this.prisma.routeComputeStat.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });

    const result: AdminRetentionResult = {
      retentionDays: days,
      cutoff: cutoff.toISOString(),
      navSessions: sessions.count,
      routes: routes.count,
      routeComputeStats: computes.count,
    };
    this.lastResult = result;
    return result;
  }

  /** Scheduled entry point: a failed sweep is logged and retried on the next tick, never thrown. */
  private async sweepQuietly(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.sweep();
      const total = result.navSessions + result.routes + result.routeComputeStats;
      if (total > 0) {
        this.logger.log(
          `Retention sweep removed ${result.navSessions} sessions, ${result.routes} routes, ` +
            `${result.routeComputeStats} compute stats older than ${result.cutoff}`,
        );
      }
    } catch (error) {
      this.logger.error(`Retention sweep failed: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }
}
