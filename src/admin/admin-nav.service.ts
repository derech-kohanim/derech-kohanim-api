import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { AppException } from '../common/app-exception';
import { PrismaService } from '../db/prisma.service';
import type {
  AdminNavFeedback,
  AdminNavSession,
  AdminNavSessionDetail,
  AdminRouteSummary,
} from './admin.types';
import type { RouteRequest, RouteResult } from '@shared';

type SessionStatusFilter = 'live' | 'ended' | 'all';

@Injectable()
export class AdminNavService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Nav sessions, newest first. "live" is any session that has not ended (endedAt null);
   * "ended" is one that has (arrived or cancelled). Per-second reporting was removed, so live
   * rows are expected to be sparse.
   */
  async listSessions(
    status: SessionStatusFilter,
    limit: number,
    offset: number,
  ): Promise<AdminNavSession[]> {
    const where: Prisma.NavSessionWhereInput =
      status === 'live'
        ? { endedAt: null }
        : status === 'ended'
          ? { endedAt: { not: null } }
          : {};

    const rows = await this.prisma.navSession.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      take: limit,
      skip: offset,
    });
    return rows.map((row) => toSession(row));
  }

  /** One session plus a summary of its route and any feedback left on that route. */
  async getSession(id: string): Promise<AdminNavSessionDetail> {
    const session = await this.prisma.navSession.findUnique({ where: { id } });
    if (!session) throw AppException.notFound('session_not_found', 'No such session');

    const route = await this.prisma.route.findUnique({ where: { id: session.routeId } });
    const feedbackRows = await this.prisma.navFeedback.findMany({
      where: { routeId: session.routeId },
      orderBy: { createdAt: 'desc' },
    });

    let routeSummary: AdminRouteSummary | null = null;
    if (route) {
      const result = route.result as unknown as RouteResult;
      const request = route.request as unknown as RouteRequest;
      routeSummary = {
        id: route.id,
        engine: result.engine,
        distanceMeters: result.distanceMeters,
        durationSeconds: result.durationSeconds,
        verifiedClean: result.verifiedClean,
        reason: result.reason,
        stringency: request.stringency,
        mode: request.mode,
        createdAt: route.createdAt.toISOString(),
      };
    }

    return {
      session: toSession(session),
      route: routeSummary,
      feedback: feedbackRows.map((row) => toFeedback(row)),
    };
  }

  /** End-of-trip feedback across all routes, newest first. */
  async listFeedback(limit: number, offset: number): Promise<AdminNavFeedback[]> {
    const rows = await this.prisma.navFeedback.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });
    return rows.map((row) => toFeedback(row));
  }
}

function toSession(row: {
  id: string;
  routeId: string;
  userId: string | null;
  simulated: boolean;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
  lastLat: number | null;
  lastLng: number | null;
  offRouteCount: number;
  rerouteCount: number;
}): AdminNavSession {
  return {
    id: row.id,
    routeId: row.routeId,
    userId: row.userId,
    simulated: row.simulated,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    lastLat: row.lastLat,
    lastLng: row.lastLng,
    offRouteCount: row.offRouteCount,
    rerouteCount: row.rerouteCount,
  };
}

function toFeedback(row: {
  id: string;
  routeId: string;
  userId: string | null;
  rating: string;
  text: string | null;
  createdAt: Date;
}): AdminNavFeedback {
  return {
    id: row.id,
    routeId: row.routeId,
    userId: row.userId,
    rating: row.rating,
    text: row.text,
    createdAt: row.createdAt.toISOString(),
  };
}
