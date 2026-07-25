import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';

import type { AdminDangerSummary } from '../admin/admin.types';
import { assertGeoJsonPolygon } from '../admin/geojson.util';
import { AppException } from '../common/app-exception';
import type { AvoidZone } from '../common/geo';
import { PG_POOL } from '../db/db.module';
import type { DangerZoneCollection, DangerZoneFeature, GeoJsonPolygon } from '@shared';

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

  // --- Admin console (/api/admin/polygons/danger) ----------------------------------------
  //
  // Admin danger-zone endpoints use the RAW database id (no DANGER_ID_OFFSET), because the
  // console operates directly on the table. The offset only exists to keep runtime danger ids
  // from colliding with stringency-zone ids inside the routing engine's blocking set.

  /** Every danger zone with a vertex count and bounding box, for the admin polygon list. */
  async adminListDanger(): Promise<AdminDangerSummary[]> {
    const { rows } = await this.pool.query<{
      id: number;
      name: string;
      city: string | null;
      vertex_count: number;
      minx: number | null;
      miny: number | null;
      maxx: number | null;
      maxy: number | null;
    }>(
      `SELECT id, name, city,
              ST_NPoints(geom) AS vertex_count,
              ST_XMin(geom) AS minx, ST_YMin(geom) AS miny,
              ST_XMax(geom) AS maxx, ST_YMax(geom) AS maxy
         FROM danger_zones
        ORDER BY id`,
    );

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      city: row.city,
      vertexCount: Number(row.vertex_count),
      bbox:
        row.minx == null
          ? null
          : [Number(row.minx), Number(row.miny), Number(row.maxx), Number(row.maxy)],
    }));
  }

  /** One danger zone as a full GeoJSON Feature. */
  async adminGetDanger(id: number): Promise<DangerZoneFeature> {
    return this.fetchDangerFeature(id);
  }

  /**
   * Updates a danger zone's properties and/or geometry and bumps its row version so clients
   * re-sync the danger layer.
   */
  async adminUpdateDanger(
    id: number,
    patch: {
      name?: string;
      city?: string | null;
      description?: string | null;
      geometry?: GeoJsonPolygon;
    },
  ): Promise<DangerZoneFeature> {
    const existing = await this.pool.query('SELECT id FROM danger_zones WHERE id = $1', [id]);
    if (existing.rowCount === 0) {
      throw AppException.notFound('danger_zone_not_found', `No danger zone with id ${id}`);
    }

    const geomJson = patch.geometry ? JSON.stringify(assertGeoJsonPolygon(patch.geometry)) : null;

    await this.pool.query(
      `UPDATE danger_zones SET
         name        = coalesce($2, name),
         city        = CASE WHEN $5 THEN $3 ELSE city END,
         description = CASE WHEN $6 THEN $4 ELSE description END,
         geom        = CASE WHEN $7::text IS NULL THEN geom
                            ELSE ST_SetSRID(ST_GeomFromGeoJSON($7), 4326) END,
         version     = version + 1
       WHERE id = $1`,
      [
        id,
        patch.name ?? null,
        patch.city ?? null,
        patch.description ?? null,
        'city' in patch,
        'description' in patch,
        geomJson,
      ],
    );

    this.cache = null;
    return this.fetchDangerFeature(id);
  }

  private async fetchDangerFeature(id: number): Promise<DangerZoneFeature> {
    const { rows } = await this.pool.query<DangerRow>(
      `SELECT id, name, city, description, ST_AsGeoJSON(geom) AS geojson
         FROM danger_zones WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) throw AppException.notFound('danger_zone_not_found', `No danger zone with id ${id}`);
    return {
      type: 'Feature',
      properties: {
        id: row.id,
        name: row.name,
        city: row.city,
        description: row.description,
      },
      geometry: JSON.parse(row.geojson),
    };
  }
}
