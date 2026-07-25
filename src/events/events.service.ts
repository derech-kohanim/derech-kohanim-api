import { Injectable } from '@nestjs/common';

import { AppException } from '../common/app-exception';
import { locateOnRoute } from '../common/geo';
import { PrismaService } from '../db/prisma.service';
import { buildSeededBundle } from './events.builder';
import type {
  CreateReportRequest,
  GeoJsonLineString,
  LatLng,
  Maneuver,
  RouteEvent,
  RouteEventBundle,
  RouteResult,
} from '@shared';

@Injectable()
export class EventsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The full feed for a route: derived zone events, then any real user reports. */
  async getBundle(routeId: string): Promise<RouteEventBundle> {
    const route = await this.loadRoute(routeId);
    const seeded = buildSeededBundle(route.geometry, route.maneuvers);

    const reports = await this.prisma.routeReport.findMany({
      where: { routeId },
      orderBy: { createdAt: 'asc' },
    });

    const reportEvents = reports.map((report) =>
      this.toReportEvent(report, route.geometry),
    );

    return {
      routeId,
      events: [...seeded.events, ...reportEvents],
      traffic: seeded.traffic,
      delaySeconds: seeded.delaySeconds,
    };
  }

  async createReport(
    routeId: string,
    userId: string,
    input: CreateReportRequest,
  ): Promise<RouteEvent> {
    const route = await this.loadRoute(routeId);

    const report = await this.prisma.routeReport.create({
      data: {
        routeId,
        userId,
        type: input.type,
        lat: input.location.lat,
        lng: input.location.lng,
      },
    });

    return this.toReportEvent(report, route.geometry);
  }

  private toReportEvent(
    report: {
      id: string;
      type: string;
      lat: number;
      lng: number;
      createdAt: Date;
    },
    geometry: GeoJsonLineString,
  ): RouteEvent {
    const location: LatLng = { lat: report.lat, lng: report.lng };
    const located = locateOnRoute(geometry, location);
    return {
      id: report.id,
      type: report.type as RouteEvent['type'],
      location,
      routeDistanceMeters: located ? Math.round(located.travelledMeters) : 0,
      reportedByUser: true,
      createdAt: report.createdAt.toISOString(),
    };
  }

  private async loadRoute(
    routeId: string,
  ): Promise<{ geometry: GeoJsonLineString; maneuvers: Maneuver[] }> {
    const row = await this.prisma.route.findUnique({ where: { id: routeId } });
    if (!row) {
      throw AppException.notFound(
        'route_not_found',
        'No such route. Compute one first, then request its events.',
      );
    }
    const result = row.result as unknown as RouteResult;
    return { geometry: result.geometry, maneuvers: result.maneuvers };
  }
}
