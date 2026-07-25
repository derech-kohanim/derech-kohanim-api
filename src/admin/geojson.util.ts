import { AppException } from '../common/app-exception';
import type { GeoJsonPolygon } from '@shared';

/**
 * Validates a GeoJSON Polygon strictly enough to trust it before handing it to PostGIS: right
 * type, at least one linear ring, every ring closed with >= 4 positions, and every position a
 * finite [lng, lat] pair in range. Throws a 400 AppException on anything malformed.
 */
export function assertGeoJsonPolygon(value: unknown): GeoJsonPolygon {
  if (!value || typeof value !== 'object') {
    throw AppException.badRequest('invalid_geometry', 'geometry must be a GeoJSON Polygon object');
  }
  const geometry = value as { type?: unknown; coordinates?: unknown };
  if (geometry.type !== 'Polygon') {
    throw AppException.badRequest('invalid_geometry', 'geometry.type must be "Polygon"');
  }
  if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0) {
    throw AppException.badRequest(
      'invalid_geometry',
      'geometry.coordinates must be a non-empty array of linear rings',
    );
  }

  for (const ring of geometry.coordinates) {
    if (!Array.isArray(ring) || ring.length < 4) {
      throw AppException.badRequest(
        'invalid_geometry',
        'each ring must have at least 4 positions (a closed triangle)',
      );
    }
    for (const position of ring) {
      if (
        !Array.isArray(position) ||
        position.length < 2 ||
        typeof position[0] !== 'number' ||
        typeof position[1] !== 'number' ||
        !Number.isFinite(position[0]) ||
        !Number.isFinite(position[1]) ||
        position[0] < -180 ||
        position[0] > 180 ||
        position[1] < -90 ||
        position[1] > 90
      ) {
        throw AppException.badRequest(
          'invalid_geometry',
          'each position must be a finite [lng, lat] pair within valid ranges',
        );
      }
    }
    const first = ring[0] as number[];
    const last = ring[ring.length - 1] as number[];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      throw AppException.badRequest(
        'invalid_geometry',
        'each ring must be closed (first and last position identical)',
      );
    }
  }

  return value as GeoJsonPolygon;
}
