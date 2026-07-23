import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';

import { PG_POOL } from '../db/db.module';
import type { Stringency, ZoneCollection, ZoneFeature } from '@shared';

/**
 * Stringency layers are cumulative: choosing a stricter layer also avoids every zone of the
 * more lenient ones (spec section 3.1). One place, changeable per association.
 */
const STRINGENCY_LEVEL: Record<Stringency, number> = {
  basic: 1,
  taharat: 2,
  machmirim: 3,
};

export const STRINGENCIES = Object.keys(STRINGENCY_LEVEL) as Stringency[];

interface ZoneRow {
  id: number;
  name: string;
  name_he: string;
  stringency: Stringency;
  city: string | null;
  street: string | null;
  description: string | null;
  geojson: string;
}

@Injectable()
export class ZonesService {
  /** Cached per stringency; invalidated whenever a layer version changes. */
  private readonly cache = new Map<Stringency, { version: number; zones: ZoneFeature[] }>();

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  static layersFor(stringency: Stringency): Stringency[] {
    const maxLevel = STRINGENCY_LEVEL[stringency];
    return STRINGENCIES.filter((key) => STRINGENCY_LEVEL[key] <= maxLevel);
  }

  /** Collection version: the highest version among the included layers. */
  async getVersion(stringency: Stringency): Promise<number> {
    const { rows } = await this.pool.query<{ version: number }>(
      `SELECT coalesce(max(version), 0)::int AS version
         FROM zone_layers
        WHERE stringency = ANY($1::text[])`,
      [ZonesService.layersFor(stringency)],
    );
    return rows[0]?.version ?? 0;
  }

  /** All zones that must be avoided at the requested stringency (cumulative). */
  async getZones(stringency: Stringency): Promise<ZoneFeature[]> {
    const version = await this.getVersion(stringency);
    const cached = this.cache.get(stringency);
    if (cached && cached.version === version) return cached.zones;

    const { rows } = await this.pool.query<ZoneRow>(
      `SELECT z.id, z.name, z.name_he, l.stringency, z.city, z.street, z.description,
              ST_AsGeoJSON(z.geom) AS geojson
         FROM zones z
         JOIN zone_layers l ON l.id = z.layer_id
        WHERE l.stringency = ANY($1::text[])
        ORDER BY z.id`,
      [ZonesService.layersFor(stringency)],
    );

    const zones: ZoneFeature[] = rows.map((row) => ({
      type: 'Feature' as const,
      properties: {
        id: row.id,
        name: row.name,
        nameHe: row.name_he,
        stringency: row.stringency,
        city: row.city,
        street: row.street,
        description: row.description,
      },
      geometry: JSON.parse(row.geojson),
    }));

    this.cache.set(stringency, { version, zones });
    return zones;
  }

  async getCollection(stringency: Stringency): Promise<ZoneCollection> {
    const [features, version] = await Promise.all([
      this.getZones(stringency),
      this.getVersion(stringency),
    ]);
    return { type: 'FeatureCollection', features, version };
  }
}
