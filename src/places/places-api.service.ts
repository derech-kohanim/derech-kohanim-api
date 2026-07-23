import { Injectable, Logger } from '@nestjs/common';

import { config } from '../config';
import { PrismaService } from '../db/prisma.service';
import { normaliseQuery } from './query';
import type { Language, LatLng } from '@shared';

const TEXT_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const PLACE_DETAILS_URL = 'https://places.googleapis.com/v1/places';

/** Only the fields we consume - the Places API (New) requires an explicit field mask. */
const SEARCH_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.types',
  'places.primaryType',
].join(',');
const DETAILS_FIELD_MASK = [
  'id',
  'displayName',
  'formattedAddress',
  'location',
  'types',
  'primaryType',
].join(',');

/** Bias radius around `near`, in meters, when the client supplies a location. */
const LOCATION_BIAS_RADIUS_METERS = 30000;
const MEMORY_CACHE_LIMIT = 500;

/**
 * After a "not enabled" error the API is skipped for this long, then probed again. A cooldown
 * rather than a permanent latch means that enabling Places API (New) in the console recovers
 * on its own within a few minutes, with no server restart.
 */
const NOT_ENABLED_COOLDOWN_MS = 3 * 60 * 1000;

export interface PlaceResult {
  placeId: string;
  name: string;
  address: string | null;
  location: LatLng;
  types: string[];
  primaryType: string | null;
}

export interface PlacesLookup {
  results: PlaceResult[];
  /** True when no upstream call was made. */
  cached: boolean;
  /** True when the Places API is not enabled/authorised on the key. */
  notEnabled: boolean;
}

interface GooglePlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  types?: string[];
  primaryType?: string;
}

interface TextSearchResponse {
  places?: GooglePlace[];
  error?: { code?: number; message?: string; status?: string };
}

/**
 * Named-place search via the Places API (New). Finds synagogues, institutions, businesses and
 * other points of interest by name, which the Geocoding API cannot do. Server-side only, both
 * to protect the key and to cache.
 *
 * Text Search is used (not Autocomplete + Details) because it returns located results in a
 * single call, so a suggestion already carries its coordinates.
 *
 * Caching is deliberately conservative: Places content may not be retained like geocoding.
 * Rows live for PLACES_CACHE_TTL_DAYS (short); the place_id inside them is the only field safe
 * to keep indefinitely, and callers that persist a pick should store the place_id, not the
 * cached name/address.
 */
@Injectable()
export class PlacesApiService {
  private readonly logger = new Logger(PlacesApiService.name);
  private readonly memory = new Map<string, PlaceResult[]>();
  /** Epoch ms until which the API is skipped after a "not enabled" error. 0 means active. */
  private disabledUntil = 0;

  constructor(private readonly prisma: PrismaService) {}

  private get disabled(): boolean {
    return Date.now() < this.disabledUntil;
  }

  get available(): boolean {
    return Boolean(config.googlePlacesApiKey) && !this.disabled;
  }

  async search(rawQuery: string, language: Language, near?: LatLng): Promise<PlacesLookup> {
    const query = normaliseQuery(rawQuery);
    if (query.length < 2) return { results: [], cached: true, notEnabled: false };

    // The bias changes the results, so it is part of the cache key at coarse resolution.
    const biasKey = near ? `@${near.lat.toFixed(2)},${near.lng.toFixed(2)}` : '';
    const key = `${language}:${query}${biasKey}`;

    const inMemory = this.memory.get(key);
    if (inMemory) return { results: inMemory, cached: true, notEnabled: false };

    const stored = await this.readCache(key, language);
    if (stored) {
      this.remember(key, stored);
      return { results: stored, cached: true, notEnabled: false };
    }

    if (!config.googlePlacesApiKey) {
      this.logger.debug('Places skipped: GOOGLE_PLACES_API_KEY is not configured');
      return { results: [], cached: true, notEnabled: false };
    }
    if (this.disabled) {
      return { results: [], cached: true, notEnabled: true };
    }

    const outcome = await this.fetchTextSearch(query, language, near);
    if (outcome.notEnabled) return { results: [], cached: false, notEnabled: true };

    this.remember(key, outcome.results);
    await this.writeCache(key, language, outcome.results);
    return { results: outcome.results, cached: false, notEnabled: false };
  }

  /** Resolves a single place by id. Suggestions from search already carry coordinates. */
  async details(placeId: string, language: Language): Promise<PlaceResult | null> {
    if (!config.googlePlacesApiKey || this.disabled) return null;

    try {
      const response = await fetch(
        `${PLACE_DETAILS_URL}/${encodeURIComponent(placeId)}?languageCode=${language}`,
        {
          headers: {
            'X-Goog-Api-Key': config.googlePlacesApiKey,
            'X-Goog-FieldMask': DETAILS_FIELD_MASK,
          },
        },
      );
      const body = (await response.json()) as GooglePlace & {
        error?: { message?: string; status?: string };
      };
      if (!response.ok || body.error) {
        this.noteFailure(response.status, body.error?.status, body.error?.message, 'details');
        return null;
      }
      return this.toResult(body);
    } catch (error) {
      this.logger.warn(`Places details error for ${placeId}: ${(error as Error).message}`);
      return null;
    }
  }

  private async fetchTextSearch(
    query: string,
    language: Language,
    near?: LatLng,
  ): Promise<{ results: PlaceResult[]; notEnabled: boolean }> {
    const body: Record<string, unknown> = {
      textQuery: query,
      languageCode: language,
      regionCode: config.geocodingRegion.toUpperCase(),
    };
    if (near) {
      body.locationBias = {
        circle: {
          center: { latitude: near.lat, longitude: near.lng },
          radius: LOCATION_BIAS_RADIUS_METERS,
        },
      };
    }

    try {
      const response = await fetch(TEXT_SEARCH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': config.googlePlacesApiKey,
          'X-Goog-FieldMask': SEARCH_FIELD_MASK,
        },
        body: JSON.stringify(body),
      });

      const payload = (await response.json()) as TextSearchResponse;
      if (!response.ok || payload.error) {
        const notEnabled = this.noteFailure(
          response.status,
          payload.error?.status,
          payload.error?.message,
          'text search',
        );
        return { results: [], notEnabled };
      }

      const results = (payload.places ?? [])
        .filter((place) => place.id && place.location?.latitude != null)
        .map((place) => this.toResult(place))
        .filter((result): result is PlaceResult => result !== null);
      return { results, notEnabled: false };
    } catch (error) {
      // A network fault must not fail the whole search; geocoding results still stand.
      this.logger.warn(`Places text search error: ${(error as Error).message}`);
      return { results: [], notEnabled: false };
    }
  }

  /** Returns true when the failure means the API is not enabled/authorised. */
  private noteFailure(
    httpStatus: number,
    status: string | undefined,
    message: string | undefined,
    where: string,
  ): boolean {
    const notEnabled =
      httpStatus === 403 ||
      status === 'PERMISSION_DENIED' ||
      /not.*enabled|SERVICE_DISABLED|API_KEY_SERVICE_BLOCKED/i.test(message ?? '');
    // Passed through verbatim (spec section 16.4): "API not enabled" reads nothing like a
    // bad key, and wrapping it hides which API the operator must turn on.
    this.logger.warn(
      `Places ${where} failed (${httpStatus} ${status ?? ''}): ${message ?? 'no detail'}`,
    );
    if (notEnabled) {
      this.disabledUntil = Date.now() + NOT_ENABLED_COOLDOWN_MS;
      this.logger.warn(
        'Places API (New) appears disabled on this key. Enable "Places API (New)" in the ' +
          'Google Cloud console, then it recovers on its own within a few minutes. Falling ' +
          'back to geocoding-only results meanwhile.',
      );
    }
    return notEnabled;
  }

  private toResult(place: GooglePlace): PlaceResult | null {
    if (!place.id || place.location?.latitude == null || place.location?.longitude == null) {
      return null;
    }
    return {
      placeId: place.id,
      name: place.displayName?.text ?? place.formattedAddress ?? '',
      address: place.formattedAddress ?? null,
      location: { lat: place.location.latitude, lng: place.location.longitude },
      types: place.types ?? [],
      primaryType: place.primaryType ?? null,
    };
  }

  private async readCache(key: string, language: Language): Promise<PlaceResult[] | null> {
    const oldest = new Date(Date.now() - config.placesCacheTtlDays * 86_400_000);
    const row = await this.prisma.placesCache.findUnique({
      where: { query_language: { query: key, language } },
    });
    if (!row || row.createdAt < oldest) return null;

    await this.prisma.placesCache
      .update({
        where: { query_language: { query: key, language } },
        data: { hits: { increment: 1 } },
      })
      .catch(() => undefined);
    return row.results as unknown as PlaceResult[];
  }

  private async writeCache(
    key: string,
    language: Language,
    results: PlaceResult[],
  ): Promise<void> {
    try {
      await this.prisma.placesCache.upsert({
        where: { query_language: { query: key, language } },
        create: { query: key, language, results: results as unknown as object },
        update: { results: results as unknown as object, createdAt: new Date(), hits: 0 },
      });
    } catch (error) {
      this.logger.warn(`Could not cache Places result: ${(error as Error).message}`);
    }
  }

  private remember(key: string, results: PlaceResult[]): void {
    if (this.memory.size >= MEMORY_CACHE_LIMIT) {
      const oldest = this.memory.keys().next().value;
      if (oldest !== undefined) this.memory.delete(oldest);
    }
    this.memory.set(key, results);
  }
}
