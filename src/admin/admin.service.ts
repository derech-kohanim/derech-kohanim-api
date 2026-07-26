import { Injectable } from '@nestjs/common';

import { config } from '../config';
import { PrismaService } from '../db/prisma.service';
import { RetentionService } from '../retention/retention.service';
import { ProviderRegistry } from '../routing/providers/provider-registry';
import { DangerZonesService } from '../zones/danger-zones.service';
import { ZonesService } from '../zones/zones.service';
import type { AdminSystem } from './admin.types';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ProviderRegistry,
    private readonly zones: ZonesService,
    private readonly dangerZones: DangerZonesService,
    private readonly retention: RetentionService,
  ) {}

  /** A single snapshot for the admin dashboard: providers, counts, data versions, uptime. */
  async system(): Promise<AdminSystem> {
    const [
      voicePacks,
      voiceClips,
      dangerZones,
      sessionsLive,
      sessionsTotal,
      computes,
      feedback,
      users,
      zoneCount,
      zonesVersion,
      dangerVersion,
      voicePacksVersion,
    ] = await Promise.all([
      this.prisma.voicePack.count(),
      this.prisma.voiceClip.count(),
      this.prisma.$queryRaw<{ count: bigint }[]>`SELECT count(*)::bigint AS count FROM danger_zones`,
      this.prisma.navSession.count({ where: { endedAt: null } }),
      this.prisma.navSession.count(),
      this.prisma.routeComputeStat.count(),
      this.prisma.navFeedback.count(),
      this.prisma.user.count(),
      this.prisma.$queryRaw<{ count: bigint }[]>`SELECT count(*)::bigint AS count FROM zones`,
      // The zone data version is the highest across all cumulative layers (machmirim includes
      // every layer), so it moves whenever any layer is bumped.
      this.zones.getVersion('machmirim'),
      this.dangerZones.getVersion(),
      this.prisma.voicePack.aggregate({ _max: { version: true } }),
    ]);

    return {
      providers: this.registry.list(),
      ttsProvider: config.ttsProvider,
      counts: {
        voicePacks,
        voiceClips,
        zones: Number(zoneCount[0]?.count ?? 0),
        dangerZones: Number(dangerZones[0]?.count ?? 0),
        sessionsLive,
        sessionsTotal,
        computes,
        feedback,
        users,
      },
      retention: {
        days: config.retentionDays,
        sweepHours: config.retentionSweepHours,
        last: this.retention.last(),
      },
      versions: {
        zones: zonesVersion,
        danger: dangerVersion,
        voicePacks: voicePacksVersion._max.version ?? 0,
      },
      uptimeSeconds: Math.round(process.uptime()),
    };
  }
}
