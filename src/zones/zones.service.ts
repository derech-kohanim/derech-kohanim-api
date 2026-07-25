import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';

import type { AdminZoneSummary } from '../admin/admin.types';
import { assertGeoJsonPolygon } from '../admin/geojson.util';
import { AppException } from '../common/app-exception';
import { PG_POOL } from '../db/db.module';
import type { GeoJsonPolygon, Stringency, ZoneCollection, ZoneFeature } from '@shared';

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

  // --- Admin console (/api/admin/polygons/zones) -----------------------------------------

  /** Every zone with a vertex count and bounding box, for the admin polygon list. */
  async adminListZones(): Promise<AdminZoneSummary[]> {
    const { rows } = await this.pool.query<{
      id: number;
      name: string;
      name_he: string;
      stringency: Stringency;
      city: string | null;
      street: string | null;
      vertex_count: number;
      minx: number | null;
      miny: number | null;
      maxx: number | null;
      maxy: number | null;
      updated_at: Date | null;
    }>(
      `SELECT z.id, z.name, z.name_he, l.stringency, z.city, z.street,
              ST_NPoints(z.geom) AS vertex_count,
              ST_XMin(z.geom) AS minx, ST_YMin(z.geom) AS miny,
              ST_XMax(z.geom) AS maxx, ST_YMax(z.geom) AS maxy,
              l.updated_at
         FROM zones z
         JOIN zone_layers l ON l.id = z.layer_id
        ORDER BY z.id`,
    );

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      nameHe: row.name_he,
      stringency: row.stringency,
      city: row.city,
      street: row.street,
      vertexCount: Number(row.vertex_count),
      bbox:
        row.minx == null
          ? null
          : [Number(row.minx), Number(row.miny), Number(row.maxx), Number(row.maxy)],
      updatedAt: row.updated_at ? row.updated_at.toISOString() : null,
    }));
  }

  /** One zone as a full GeoJSON Feature (geometry + properties). */
  async adminGetZone(id: number): Promise<ZoneFeature> {
    return this.fetchZoneFeature(id);
  }

  /**
   * Updates a zone's properties and/or geometry, then bumps every zone-layer version so all
   * clients re-sync (stringency layers are cumulative, so an over-bump is the safe choice).
   */
  async adminUpdateZone(
    id: number,
    patch: {
      name?: string;
      nameHe?: string;
      city?: string | null;
      street?: string | null;
      description?: string | null;
      stringency?: Stringency;
      geometry?: GeoJsonPolygon;
    },
  ): Promise<ZoneFeature> {
    const existing = await this.pool.query('SELECT id FROM zones WHERE id = $1', [id]);
    if (existing.rowCount === 0) {
      throw AppException.notFound('zone_not_found', `No zone with id ${id}`);
    }

    let layerId: number | null = null;
    if (patch.stringency) {
      const layer = await this.pool.query<{ id: number }>(
        'SELECT id FROM zone_layers WHERE stringency = $1',
        [patch.stringency],
      );
      if (layer.rowCount === 0) {
        throw AppException.badRequest('unknown_stringency', `No layer for ${patch.stringency}`);
      }
      layerId = layer.rows[0].id;
    }

    const geomJson = patch.geometry ? JSON.stringify(assertGeoJsonPolygon(patch.geometry)) : null;

    await this.pool.query(
      `UPDATE zones SET
         name        = coalesce($2, name),
         name_he     = coalesce($3, name_he),
         city        = CASE WHEN $9 THEN $4 ELSE city END,
         street      = CASE WHEN $10 THEN $5 ELSE street END,
         description = CASE WHEN $11 THEN $6 ELSE description END,
         layer_id    = coalesce($7, layer_id),
         geom        = CASE WHEN $8::text IS NULL THEN geom
                            ELSE ST_SetSRID(ST_GeomFromGeoJSON($8), 4326) END
       WHERE id = $1`,
      [
        id,
        patch.name ?? null,
        patch.nameHe ?? null,
        patch.city ?? null,
        patch.street ?? null,
        patch.description ?? null,
        layerId,
        geomJson,
        'city' in patch,
        'street' in patch,
        'description' in patch,
      ],
    );

    await this.bumpAllLayerVersions();
    this.cache.clear();
    return this.fetchZoneFeature(id);
  }

  private async bumpAllLayerVersions(): Promise<void> {
    await this.pool.query('UPDATE zone_layers SET version = version + 1, updated_at = now()');
  }

  private async fetchZoneFeature(id: number): Promise<ZoneFeature> {
    const { rows } = await this.pool.query<ZoneRow>(
      `SELECT z.id, z.name, z.name_he, l.stringency, z.city, z.street, z.description,
              ST_AsGeoJSON(z.geom) AS geojson
         FROM zones z
         JOIN zone_layers l ON l.id = z.layer_id
        WHERE z.id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) throw AppException.notFound('zone_not_found', `No zone with id ${id}`);
    return {
      type: 'Feature',
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
    };
  }
}
