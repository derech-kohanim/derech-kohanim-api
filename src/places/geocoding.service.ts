import { Injectable, Logger } from '@nestjs/common';

import { config } from '../config';
import { PrismaService } from '../db/prisma.service';
import { normaliseQuery } from './query';
import type { Language, LatLng } from '@shared';

const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

/** Small in-process cache in front of Postgres, for repeated typing of the same query. */
const MEMORY_CACHE_LIMIT = 500;

export interface GeocodeResult {
  label: string;
  location: LatLng;
  placeId: string;
  types: string[];
}

export interface GeocodeLookup {
  results: GeocodeResult[];
  /** True when no upstream call was made. */
  cached: boolean;
}

interface GoogleGeocodeResponse {
  status: string;
  error_message?: string;
  results?: {
    formatted_address?: string;
    place_id?: string;
    types?: string[];
    geometry?: { location?: { lat: number; lng: number } };
  }[];
}

/**
 * Address search happens on the server only (spec section 6.6): it protects the key and it
 * is the only place a cache can live. Two layers - process memory, then Postgres - so a
 * repeated query never costs an upstream call.
 */
@Injectable()
export class GeocodingService {
  private readonly logger = new Logger(GeocodingService.name);
  private readonly memory = new Map<string, GeocodeResult[]>();

  constructor(private readonly prisma: PrismaService) {}

  get available(): boolean {
    return Boolean(config.googleGeocodingApiKey);
  }

  async search(rawQuery: string, language: Language): Promise<GeocodeLookup> {
    const query = normaliseQuery(rawQuery);
    if (query.length < 2) return { results: [], cached: true };

    const key = `${language}:${query}`;

    const inMemory = this.memory.get(key);
    if (inMemory) return { results: inMemory, cached: true };

    const stored = await this.readCache(query, language);
    if (stored) {
      this.remember(key, stored);
      return { results: stored, cached: true };
    }

    if (!this.available) {
      // Not an error: the rest of the suggestion list (saved, recent, coordinates) is still
      // useful without a geocoding key, and the client should not lose it.
      this.logger.debug('Geocoding skipped: GOOGLE_GEOCODING_API_KEY is not configured');
      return { results: [], cached: true };
    }

    const results = await this.fetchFromGoogle({ address: query }, language);
    this.remember(key, results);
    await this.writeCache(query, language, results);
    return { results, cached: false };
  }

  /** Resolves a stable place id. Place ids may be stored indefinitely under Google's terms. */
  async details(placeId: string, language: Language): Promise<GeocodeResult | null> {
    const cached = await this.prisma.placeDetailsCache.findUnique({
      where: { externalId_language: { externalId: placeId, language } },
    });
    if (cached) {
      await this.prisma.placeDetailsCache
        .update({
          where: { externalId_language: { externalId: placeId, language } },
          data: { hits: { increment: 1 } },
        })
        .catch(() => undefined);
      return cached.payload as unknown as GeocodeResult;
    }

    if (!this.available) return null;

    const results = await this.fetchFromGoogle({ place_id: placeId }, language);
    const result = results[0] ?? null;
    if (result) {
      await this.prisma.placeDetailsCache
        .create({
          data: {
            externalId: placeId,
            language,
            payload: result as unknown as object,
          },
        })
        .catch(() => undefined);
    }
    return result;
  }

  private async fetchFromGoogle(
    lookup: Record<string, string>,
    language: Language,
  ): Promise<GeocodeResult[]> {
    const params = new URLSearchParams({
      ...lookup,
      language,
      // Bias, not restriction: a query outside the region still resolves.
      region: config.geocodingRegion,
      key: config.googleGeocodingApiKey,
    });

    const response = await fetch(`${GEOCODE_URL}?${params.toString()}`);
    const body = (await response.json()) as GoogleGeocodeResponse;

    if (body.status === 'ZERO_RESULTS') return [];
    if (body.status !== 'OK') {
      // Passed through verbatim: "this API is not enabled" reads nothing like "bad key".
      throw new Error(
        `Google geocoding failed (${body.status}): ${body.error_message ?? 'no detail'}`,
      );
    }

    return (body.results ?? [])
      .filter((item) => item.geometry?.location)
      .map((item) => ({
        label: item.formatted_address ?? '',
        location: {
          lat: item.geometry!.location!.lat,
          lng: item.geometry!.location!.lng,
        },
        placeId: item.place_id ?? '',
        types: item.types ?? [],
      }));
  }

  private async readCache(
    query: string,
    language: Language,
  ): Promise<GeocodeResult[] | null> {
    const oldest = new Date(Date.now() - config.geocodeCacheTtlDays * 86_400_000);
    const row = await this.prisma.geocodeCache.findUnique({
      where: { query_language: { query, language } },
    });
    if (!row || row.createdAt < oldest) return null;

    await this.prisma.geocodeCache
      .update({
        where: { query_language: { query, language } },
        data: { hits: { increment: 1 } },
      })
      .catch(() => undefined);

    return row.results as unknown as GeocodeResult[];
  }

  private async writeCache(
    query: string,
    language: Language,
    results: GeocodeResult[],
  ): Promise<void> {
    try {
      await this.prisma.geocodeCache.upsert({
        where: { query_language: { query, language } },
        create: { query, language, results: results as unknown as object },
        update: { results: results as unknown as object, createdAt: new Date(), hits: 0 },
      });
    } catch (error) {
      // A cache write failure must never fail the request it was meant to speed up.
      this.logger.warn(`Could not cache geocoding result: ${(error as Error).message}`);
    }
  }

  private remember(key: string, results: GeocodeResult[]): void {
    if (this.memory.size >= MEMORY_CACHE_LIMIT) {
      const oldest = this.memory.keys().next().value;
      if (oldest !== undefined) this.memory.delete(oldest);
    }
    this.memory.set(key, results);
  }

  /** Cache statistics, so the saving is measurable rather than assumed. */
  async stats(): Promise<{ entries: number; hits: number; available: boolean }> {
    const [entries, aggregate] = await Promise.all([
      this.prisma.geocodeCache.count(),
      this.prisma.geocodeCache.aggregate({ _sum: { hits: true } }),
    ]);
    return { entries, hits: aggregate._sum.hits ?? 0, available: this.available };
  }
}
