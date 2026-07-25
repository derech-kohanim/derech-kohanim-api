import { Injectable, Logger } from '@nestjs/common';

import { AppException } from '../common/app-exception';
import {
  cumulativeDistances,
  locateOnRoute,
  metersBetween,
  nearestZone,
  toManeuverZone,
  zonesNearCorridor,
} from '../common/geo';
import { config } from '../config';
import { PrismaService } from '../db/prisma.service';
import { RoutingService } from '../routing/routing.service';
import { DangerZonesService } from '../zones/danger-zones.service';
import { ZonesService } from '../zones/zones.service';
import type { AvoidZone } from '../common/geo';
import type { CreateSessionDto, NavFeedbackDto, ProgressDto } from './navigation.dto';
import type {
  NavFeedback,
  NavigationProgressResponse,
  NavigationSession,
  NavigationStatus,
  RouteRequest,
  RouteResult,
} from '@shared';

@Injectable()
export class NavigationService {
  private readonly logger = new Logger(NavigationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly routing: RoutingService,
    private readonly zones: ZonesService,
    private readonly dangerZones: DangerZonesService,
  ) {}

  async create(userId: string | null, input: CreateSessionDto): Promise<NavigationSession> {
    const route = await this.prisma.route.findUnique({ where: { id: input.routeId } });
    if (!route) {
      throw AppException.notFound('route_not_found', 'No such route. Compute one first.');
    }

    const result = route.result as unknown as RouteResult;
    const request = route.request as unknown as RouteRequest;

    // Halachic safety above everything: an unverified route may be displayed, never driven.
    if (!result.verifiedClean) {
      throw AppException.badRequest(
        'route_not_verified',
        'This route was not verified clean, so live navigation cannot start from it',
        { reason: result.reason },
      );
    }

    const session = await this.prisma.navSession.create({
      data: {
        userId,
        routeId: route.id,
        status: 'navigating',
        simulated: input.simulated ?? false,
        stringency: request.stringency,
        trafficAware: request.trafficAware,
        engine: result.engine,
      },
    });

    return toSession(session);
  }

  async get(sessionId: string, userId: string | null): Promise<NavigationSession> {
    return toSession(await this.load(sessionId, userId));
  }

  async end(
    sessionId: string,
    userId: string | null,
    arrived: boolean,
  ): Promise<NavigationSession> {
    const session = await this.load(sessionId, userId);
    const updated = await this.prisma.navSession.update({
      where: { id: session.id },
      data: { status: arrived ? 'arrived' : 'cancelled', endedAt: new Date() },
    });
    return toSession(updated);
  }

  /**
   * One position report. Everything the driving screen shows is derived here: which step is
   * next, how far it is, what is left, whether a zone is close, and whether the driver has
   * left the route and needs a new one.
   */
  async progress(
    sessionId: string,
    userId: string | null,
    input: ProgressDto,
  ): Promise<NavigationProgressResponse> {
    const session = await this.load(sessionId, userId);
    if (session.status === 'arrived' || session.status === 'cancelled') {
      throw AppException.badRequest('session_finished', 'This navigation session is over');
    }

    const stored = await this.prisma.route.findUnique({ where: { id: session.routeId } });
    if (!stored) throw AppException.notFound('route_not_found', 'Session route is gone');

    let route = stored.result as unknown as RouteResult;
    const request = stored.request as unknown as RouteRequest;
    const position = input.location;

    let located = locateOnRoute(route.geometry, position);
    if (!located) {
      throw AppException.badRequest('route_degenerate', 'Route geometry has too few points');
    }

    let status: NavigationStatus = 'navigating';
    let rerouted: RouteResult | undefined;
    let offRouteCount = session.offRouteCount;

    if (located.offsetMeters > config.offRouteThresholdMeters) {
      offRouteCount += 1;
      // One noisy fix is not a wrong turn. Several in a row is.
      if (offRouteCount >= config.offRouteReportsBeforeReroute) {
        rerouted = await this.reroute(session.id, request, position, session.userId);
        route = rerouted;
        located = locateOnRoute(route.geometry, position) ?? located;
        offRouteCount = 0;
        status = 'rerouting';
      }
    } else {
      offRouteCount = 0;
    }

    const cumulative = cumulativeDistances(route.geometry);
    const totalMeters = cumulative[cumulative.length - 1] ?? 0;
    const travelled = Math.min(located.travelledMeters, totalMeters);
    const distanceRemaining = Math.max(0, Math.round(totalMeters - travelled));

    // The step the driver is heading towards, not the one just passed.
    const currentManeuverIndex = route.maneuvers.findIndex(
      (maneuver) => maneuver.geometryIndex > located!.vertexIndex,
    );
    const index =
      currentManeuverIndex === -1
        ? Math.max(0, route.maneuvers.length - 1)
        : currentManeuverIndex;

    const target = route.maneuvers[index];
    const distanceToManeuver = target
      ? Math.max(
          0,
          Math.round((cumulative[target.geometryIndex] ?? totalMeters) - travelled),
        )
      : distanceRemaining;

    const ratio = totalMeters === 0 ? 0 : distanceRemaining / totalMeters;
    const durationRemaining = Math.round(route.durationSeconds * ratio);

    const destination = request.destination;
    const arrived = metersBetween(position, destination) <= config.arrivalThresholdMeters;
    if (arrived) status = 'arrived';

    await this.prisma.navSession.update({
      where: { id: session.id },
      data: {
        lastLat: position.lat,
        lastLng: position.lng,
        offRouteCount,
        status,
        ...(status === 'arrived' ? { endedAt: new Date() } : {}),
        ...(rerouted ? { rerouteCount: { increment: 1 } } : {}),
      },
    });

    return {
      status,
      currentManeuverIndex: index,
      distanceToManeuverMeters: distanceToManeuver,
      distanceRemainingMeters: distanceRemaining,
      durationRemainingSeconds: durationRemaining,
      ...(rerouted ? { route: rerouted } : {}),
      ...(await this.zoneAlert(position, request)),
    };
  }

  /**
   * Records end-of-trip feedback for a route. Guests may submit anonymously (userId null); a
   * signed-in driver's feedback is associated with their account.
   */
  async createFeedback(
    userId: string | null,
    input: NavFeedbackDto,
  ): Promise<NavFeedback> {
    const route = await this.prisma.route.findUnique({ where: { id: input.routeId } });
    if (!route) {
      throw AppException.notFound('route_not_found', 'No such route to leave feedback on');
    }

    const feedback = await this.prisma.navFeedback.create({
      data: {
        routeId: input.routeId,
        userId,
        rating: input.rating,
        text: input.text ?? null,
      },
    });

    return {
      id: feedback.id,
      routeId: feedback.routeId,
      rating: feedback.rating as NavFeedback['rating'],
      text: feedback.text,
      createdAt: feedback.createdAt.toISOString(),
    };
  }

  private async reroute(
    sessionId: string,
    request: RouteRequest,
    from: { lat: number; lng: number },
    userId: string | null,
  ): Promise<RouteResult> {
    this.logger.log(`Session ${sessionId}: driver left the route, recomputing`);

    const plan = await this.routing.computeAndStorePlan(
      { ...request, origin: from },
      userId,
    );

    // The reroute takes the best (fastest) clean alternative.
    const result = plan.routes[0];
    if (!result || !result.verifiedClean) {
      // Failing safe is the point: say so rather than quietly guide through a zone.
      throw AppException.badGateway(
        'reroute_not_verified',
        'No verified clean route was found from the current position',
        { reason: result?.reason },
      );
    }

    await this.prisma.navSession.update({
      where: { id: sessionId },
      data: { routeId: result.id },
    });
    return result;
  }

  /**
   * Early warning, not an after the fact notice (spec section 17.4). Considers the halachic
   * stringency zones and, when the route avoids them, the danger zones too, so the alert can
   * say which it is. The alert zone carries the description and city for the client to show.
   */
  private async zoneAlert(
    position: { lat: number; lng: number },
    request: RouteRequest,
  ): Promise<Pick<NavigationProgressResponse, 'zoneAlert'>> {
    const stringencyZones = await this.zones.getZones(request.stringency);
    const dangerZones =
      request.avoidDangerZones !== false ? await this.dangerZones.getAvoidZones() : [];
    // Only zones around the live position can trigger an alert; drop the rest for speed.
    const zones: AvoidZone[] = zonesNearCorridor(
      [...stringencyZones, ...dangerZones],
      position,
      position,
    );

    const nearest = nearestZone(position, zones);
    if (!nearest) return {};
    if (!nearest.inside && nearest.distanceMeters > config.zoneAlertRadiusMeters) return {};

    return {
      zoneAlert: {
        type: nearest.inside ? 'zone_enter' : 'zone_ahead',
        zone: toManeuverZone(nearest.zone),
        distanceMeters: nearest.distanceMeters,
      },
    };
  }

  private async load(sessionId: string, userId: string | null) {
    const session = await this.prisma.navSession.findUnique({ where: { id: sessionId } });
    if (!session) throw AppException.notFound('session_not_found', 'No such session');
    // A guest session has no owner, so anyone holding the id may report on it.
    if (session.userId && session.userId !== userId) {
      throw AppException.forbidden('session_forbidden', 'This session belongs to another user');
    }
    return session;
  }
}

function toSession(row: {
  id: string;
  routeId: string;
  status: string;
  simulated: boolean;
  startedAt: Date;
}): NavigationSession {
  return {
    id: row.id,
    routeId: row.routeId,
    status: row.status as NavigationStatus,
    simulated: row.simulated,
    startedAt: row.startedAt.toISOString(),
  };
}
