import { Injectable } from '@nestjs/common';
import type { Prisma, Route as RouteRow } from '@prisma/client';

import { AppException } from '../common/app-exception';
import { PrismaService } from '../db/prisma.service';
import type {
  AdminNavFeedback,
  AdminNavSession,
  AdminNavSessionDetail,
  AdminNavSessionRoute,
  AdminRouteSummary,
} from './admin.types';
import type { RouteRequest, RouteResult } from '@shared';

type SessionStatusFilter = 'live' | 'ended' | 'all';

/** Rows the session list needs from the joined route, kept narrow: geometry is never selected. */
type SessionRow = Prisma.NavSessionGetPayload<{ include: { route: true } }>;

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
    userId?: string,
  ): Promise<AdminNavSession[]> {
    const where: Prisma.NavSessionWhereInput = {
      ...(status === 'live' ? { endedAt: null } : {}),
      ...(status === 'ended' ? { endedAt: { not: null } } : {}),
      ...(userId ? { userId } : {}),
    };

    const rows = await this.prisma.navSession.findMany({
      where,
      include: { route: true },
      orderBy: { startedAt: 'desc' },
      take: limit,
      skip: offset,
    });
    return rows.map((row) => toSession(row));
  }

  /**
   * One session with the full debug picture: the route it is on, the other routes the same
   * compute offered, the reroute trail, and the feedback left on the route.
   */
  async getSession(id: string): Promise<AdminNavSessionDetail> {
    const session = await this.prisma.navSession.findUnique({
      where: { id },
      include: { route: true, routes: { orderBy: { createdAt: 'asc' } } },
    });
    if (!session) throw AppException.notFound('session_not_found', 'No such session');

    const current = session.route ? toRouteSummary(session.route) : null;

    // Sibling routes of the same compute. Rows written before plan tracking have no planId, so
    // the plan comes back empty rather than guessing at siblings by matching request payloads.
    const planRows = session.route?.planId
      ? await this.prisma.route.findMany({
          where: { planId: session.route.planId },
          orderBy: { rank: 'asc' },
        })
      : [];

    // The trail is authoritative when present. Sessions started before it existed still show at
    // least the route they are on now, so the view is never blank for older data.
    const legRows = session.routes.length
      ? session.routes
      : [{ routeId: session.routeId, reason: 'initial', createdAt: session.startedAt }];

    const legRouteIds = legRows.map((leg) => leg.routeId);
    const legRoutes = await this.prisma.route.findMany({ where: { id: { in: legRouteIds } } });
    const byId = new Map(legRoutes.map((route) => [route.id, toRouteSummary(route)]));

    const legs: AdminNavSessionRoute[] = legRows.map((leg) => ({
      routeId: leg.routeId,
      reason: leg.reason,
      at: leg.createdAt.toISOString(),
      current: leg.routeId === session.routeId,
      route: byId.get(leg.routeId) ?? null,
    }));

    const feedbackRows = await this.prisma.navFeedback.findMany({
      where: { routeId: { in: [...new Set([session.routeId, ...legRouteIds])] } },
      orderBy: { createdAt: 'desc' },
    });

    return {
      session: toSession(session),
      route: current,
      plan: planRows.map((row) => toRouteSummary(row)),
      legs,
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

function toSession(row: SessionRow): AdminNavSession {
  const result = row.route ? (row.route.result as unknown as RouteResult) : null;
  return {
    id: row.id,
    routeId: row.routeId,
    userId: row.userId,
    simulated: row.simulated,
    status: row.status,
    // 'arrived' and 'cancelled' are the two terminal states; anything else is still running.
    arrived: row.endedAt ? row.status === 'arrived' : null,
    stringency: row.stringency,
    engine: row.engine,
    trafficAware: row.trafficAware,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    lastLat: row.lastLat,
    lastLng: row.lastLng,
    offRouteCount: row.offRouteCount,
    rerouteCount: row.rerouteCount,
    distanceMeters: result?.distanceMeters ?? null,
    durationSeconds: result?.durationSeconds ?? null,
  };
}

export function toRouteSummary(row: RouteRow): AdminRouteSummary {
  const result = row.result as unknown as RouteResult;
  const request = row.request as unknown as RouteRequest;

  return {
    id: row.id,
    planId: row.planId,
    role: row.role,
    rank: row.rank,
    engine: result.engine,
    distanceMeters: result.distanceMeters,
    durationSeconds: result.durationSeconds,
    verifiedClean: result.verifiedClean,
    reason: result.reason,
    label: result.label,
    detourRatio: result.detourRatio,
    avoidsTolls: result.avoidsTolls,
    stringency: request.stringency,
    mode: request.mode,
    origin: request.origin,
    destination: request.destination,
    avoidDangerZones: request.avoidDangerZones !== false,
    avoidTolls: request.avoidTolls ?? false,
    trafficAware: request.trafficAware,
    geometryPoints: result.geometry?.coordinates?.length ?? 0,
    maneuverCount: result.maneuvers?.length ?? 0,
    zoneManeuvers: result.maneuvers?.filter((maneuver) => maneuver.zone).length ?? 0,
    attempts: result.debug?.attempts ?? [],
    naiveDistanceMeters: result.debug?.naiveDistanceMeters,
    createdAt: row.createdAt.toISOString(),
  };
}

function toFeedback(row: {
  id: string;
  routeId: string | null;
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
