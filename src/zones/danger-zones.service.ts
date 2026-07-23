import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';

import type { AvoidZone } from '../common/geo';
import { PG_POOL } from '../db/db.module';
import type { DangerZoneCollection, DangerZoneFeature } from '@shared';

/**
 * Danger zones (Oslo "Area A") are a separate axis from halachic stringency: their own table,
 * their own version, avoided independently via `avoidDangerZones`.
 */
const DANGER_ID_OFFSET = 1_000_000;

interface DangerRow {
  id: number;
  name: string;
  city: string | null;
  description: string | null;
  geojson: string;
}

@Injectable()
export class DangerZonesService {
  private cache: { version: number; zones: AvoidZone[] } | null = null;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async getVersion(): Promise<number> {
    const { rows } = await this.pool.query<{ version: number }>(
      `SELECT coalesce(max(version), 0)::int AS version FROM danger_zones`,
    );
    return rows[0]?.version ?? 0;
  }

  private async load(): Promise<AvoidZone[]> {
    const version = await this.getVersion();
    if (this.cache && this.cache.version === version) return this.cache.zones;

    const { rows } = await this.pool.query<DangerRow>(
      `SELECT id, name, city, description, ST_AsGeoJSON(geom) AS geojson
         FROM danger_zones
        ORDER BY id`,
    );

    // Modeled as AvoidZone so the same verification and annotation code handles them. The id is
    // offset so it never collides with a stringency zone id in the detour search's blocking set.
    const zones: AvoidZone[] = rows.map((row) => ({
      type: 'Feature' as const,
      danger: true,
      properties: {
        id: row.id + DANGER_ID_OFFSET,
        name: row.name,
        nameHe: row.name,
        stringency: 'basic',
        city: row.city,
        street: null,
        description: row.description,
      },
      geometry: JSON.parse(row.geojson),
    }));

    this.cache = { version, zones };
    return zones;
  }

  /** Danger zones as avoidable polygons for the routing pipeline. */
  async getAvoidZones(): Promise<AvoidZone[]> {
    return this.load();
  }

  /** The public collection, in the danger-zone contract shape. */
  async getCollection(): Promise<DangerZoneCollection> {
    const [zones, version] = await Promise.all([this.load(), this.getVersion()]);
    const features: DangerZoneFeature[] = zones.map((zone) => ({
      type: 'Feature',
      properties: {
        id: zone.properties.id,
        name: zone.properties.name,
        city: zone.properties.city,
        description: zone.properties.description,
      },
      geometry: zone.geometry,
    }));
    return { type: 'FeatureCollection', features, version };
  }
}
