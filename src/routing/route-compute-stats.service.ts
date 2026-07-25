import { AsyncLocalStorage } from 'node:async_hooks';

import { Injectable, Logger } from '@nestjs/common';

import { AppException } from '../common/app-exception';
import { PrismaService } from '../db/prisma.service';
import type {
  AdminRouteCompute,
  AdminRouteComputeDetail,
} from '../admin/admin.types';
import type { RouteResult } from '@shared';

/**
 * A single compute's telemetry, filled in two places: RoutingService records the compute
 * timing and route facts, the timing interceptor stamps handlingMs and persists. `computeMs`
 * being set is the signal that a compute actually ran (so reroutes and non-compute paths, which
 * have no ambient draft, never write a row).
 */
export interface ComputeStatDraft {
  provider?: string;
  engine?: string;
  computeMs?: number;
  handlingMs?: number;
  alternativeCount?: number;
  verifiedClean?: boolean;
  stringency?: string;
  mode?: string;
  originLat?: number;
  originLng?: number;
  destLat?: number;
  destLng?: number;
  distanceMeters?: number | null;
  durationSeconds?: number | null;
  avoidDangerZones?: boolean;
  avoidTolls?: boolean;
  routeId?: string | null;
  userId?: string | null;
}

/**
 * Collects per-compute timing telemetry and reads it back for the admin console. The write path
 * is deliberately best-effort: it only ever touches an in-memory draft during a compute and
 * defers the single DB insert to after the response, wrapped so a telemetry failure can never
 * break or slow POST /api/routes/compute.
 */
@Injectable()
export class RouteComputeStatsService {
  private readonly logger = new Logger(RouteComputeStatsService.name);
  /** Correlates the interceptor's draft with RoutingService's record() for one request. */
  readonly als = new AsyncLocalStorage<ComputeStatDraft>();

  constructor(private readonly prisma: PrismaService) {}

  createDraft(): ComputeStatDraft {
    return {};
  }

  /** Merge compute facts into the current request's draft, if one is in scope. */
  record(fields: ComputeStatDraft): void {
    const draft = this.als.getStore();
    if (!draft) return;
    Object.assign(draft, fields);
  }

  /**
   * Persist a completed draft. A no-op unless a compute actually ran (computeMs set). Never
   * throws: telemetry must not be able to fail a request.
   */
  async persist(draft: ComputeStatDraft): Promise<void> {
    if (draft.computeMs == null) return;
    try {
      await this.prisma.routeComputeStat.create({
        data: {
          provider: draft.provider ?? 'unknown',
          engine: draft.engine ?? 'unknown',
          computeMs: Math.round(draft.computeMs),
          handlingMs: Math.round(draft.handlingMs ?? draft.computeMs),
          alternativeCount: draft.alternativeCount ?? 0,
          verifiedClean: draft.verifiedClean ?? false,
          stringency: draft.stringency ?? 'basic',
          mode: draft.mode ?? 'drive',
          originLat: draft.originLat ?? 0,
          originLng: draft.originLng ?? 0,
          destLat: draft.destLat ?? 0,
          destLng: draft.destLng ?? 0,
          distanceMeters:
            draft.distanceMeters == null ? null : Math.round(draft.distanceMeters),
          durationSeconds:
            draft.durationSeconds == null ? null : Math.round(draft.durationSeconds),
          avoidDangerZones: draft.avoidDangerZones ?? true,
          avoidTolls: draft.avoidTolls ?? false,
          routeId: draft.routeId ?? null,
          userId: draft.userId ?? null,
        },
      });
    } catch (error) {
      this.logger.warn(`Failed to persist route compute stat: ${(error as Error).message}`);
    }
  }

  async list(limit: number, offset: number): Promise<AdminRouteCompute[]> {
    const rows = await this.prisma.routeComputeStat.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });
    return rows.map((row) => this.toApi(row));
  }

  async get(id: string): Promise<AdminRouteComputeDetail> {
    const row = await this.prisma.routeComputeStat.findUnique({ where: { id } });
    if (!row) throw AppException.notFound('compute_not_found', 'No such route compute stat');

    let route: AdminRouteComputeDetail['route'] = null;
    if (row.routeId) {
      const stored = await this.prisma.route.findUnique({ where: { id: row.routeId } });
      if (stored) {
        const result = stored.result as unknown as RouteResult;
        route = {
          id: stored.id,
          geometryPoints: result.geometry?.coordinates?.length ?? 0,
          distanceMeters: result.distanceMeters,
          durationSeconds: result.durationSeconds,
          verifiedClean: result.verifiedClean,
          attempts: result.debug?.attempts ?? [],
          naiveDistanceMeters: result.debug?.naiveDistanceMeters,
        };
      }
    }

    return { ...this.toApi(row), route };
  }

  private toApi(row: {
    id: string;
    createdAt: Date;
    provider: string;
    engine: string;
    computeMs: number;
    handlingMs: number;
    alternativeCount: number;
    verifiedClean: boolean;
    stringency: string;
    mode: string;
    originLat: number;
    originLng: number;
    destLat: number;
    destLng: number;
    distanceMeters: number | null;
    durationSeconds: number | null;
    avoidDangerZones: boolean;
    avoidTolls: boolean;
    routeId: string | null;
    userId: string | null;
  }): AdminRouteCompute {
    return {
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      provider: row.provider,
      engine: row.engine,
      computeMs: row.computeMs,
      handlingMs: row.handlingMs,
      alternativeCount: row.alternativeCount,
      verifiedClean: row.verifiedClean,
      stringency: row.stringency,
      mode: row.mode,
      originLat: row.originLat,
      originLng: row.originLng,
      destLat: row.destLat,
      destLng: row.destLng,
      distanceMeters: row.distanceMeters,
      durationSeconds: row.durationSeconds,
      avoidDangerZones: row.avoidDangerZones,
      avoidTolls: row.avoidTolls,
      routeId: row.routeId,
      userId: row.userId,
    };
  }
}
