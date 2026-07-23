import { Injectable, Logger } from '@nestjs/common';

import { AppException } from '../common/app-exception';
import { metersBetween } from '../common/geo';
import { PrismaService } from '../db/prisma.service';
import { GeocodingService, type GeocodeResult } from './geocoding.service';
import { PlacesApiService, type PlaceResult } from './places-api.service';
import type { SavePlaceDto, UpdateSavedPlaceDto } from './places.dto';
import { formatCoordinates, matchedRanges, matchScore, parseCoordinates } from './query';
import type {
  Language,
  LatLng,
  PlaceCategory,
  PlaceSearchResponse,
  PlaceSuggestion,
  RecentPlace,
  SavedPlace,
} from '@shared';

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 25;
/** Personal results are the point of signing in, so they never get crowded out. */
const MAX_PERSONAL_RESULTS = 5;

@Injectable()
export class PlacesService {
  private readonly logger = new Logger(PlacesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly geocoding: GeocodingService,
    private readonly places: PlacesApiService,
  ) {}

  /**
   * The destination field of the whole product.
   *
   * Order is deliberate and is what makes the field feel instant: what the user already
   * knows comes first (coordinates parsed locally, then their saved and recent places),
   * and only then the upstream geocoder, which is cached so a repeated query is free.
   */
  async search(input: {
    query: string;
    language: Language;
    near?: LatLng;
    limit?: number;
    userId: string | null;
  }): Promise<PlaceSearchResponse> {
    const query = input.query.trim();
    const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const suggestions: PlaceSuggestion[] = [];
    let cached = true;

    // 1. A coordinate pair is answered locally. No upstream call, ever.
    const coordinates = parseCoordinates(query);
    if (coordinates) {
      suggestions.push(
        this.withDistance(
          {
            id: `coord:${coordinates.lat},${coordinates.lng}`,
            title: formatCoordinates(coordinates),
            subtitle: null,
            category: 'coordinates',
            kind: 'coordinates',
            location: coordinates,
            externalId: null,
            distanceMeters: null,
            matchedRanges: [{ start: 0, length: formatCoordinates(coordinates).length }],
          },
          input.near,
        ),
      );
    }

    // 2. The user's own places, before anything upstream.
    if (input.userId) {
      suggestions.push(
        ...(await this.personalSuggestions(input.userId, query, input.near)),
      );
    }

    // 3. Upstream results: named POIs from Places and addresses from geocoding, merged.
    //    Places is queried first so a named match (a synagogue, an institution) outranks the
    //    bare street address of the same spot; dedupe then removes the duplicate.
    if (!coordinates && query.length >= 2) {
      const upstream: PlaceSuggestion[] = [];

      // 3a. Named places (POIs). A disabled or unreachable Places API must not fail search.
      try {
        const lookup = await this.places.search(query, input.language, input.near);
        if (!lookup.cached) cached = false;
        for (const result of lookup.results) {
          upstream.push(this.withDistance(this.fromPlace(result, query), input.near));
        }
      } catch (error) {
        this.logger.warn(`Places search failed for "${query}": ${(error as Error).message}`);
      }

      // 3b. Geocoding (addresses, and structured place types).
      try {
        const lookup = await this.geocoding.search(query, input.language);
        if (!lookup.cached) cached = false;
        for (const result of lookup.results) {
          upstream.push(this.withDistance(this.fromGeocode(result, query), input.near));
        }
      } catch (error) {
        // A geocoder outage must not wipe out the personal or Places results already gathered.
        this.logger.warn(`Geocoding failed for "${query}": ${(error as Error).message}`);
        if (suggestions.length === 0 && upstream.length === 0) {
          throw AppException.badGateway('geocoding_failed', (error as Error).message);
        }
      }

      suggestions.push(...upstream);
    }

    return { query, suggestions: dedupe(suggestions).slice(0, limit), cached };
  }

  async details(id: string, language: Language, userId: string | null) {
    const [kind, ...rest] = id.split(':');
    const value = rest.join(':');

    if (kind === 'coord') {
      const point = parseCoordinates(value);
      if (!point) throw AppException.badRequest('invalid_place_id', 'Malformed coordinate id');
      return this.withDistance(
        {
          id,
          title: formatCoordinates(point),
          subtitle: null,
          category: 'coordinates',
          kind: 'coordinates',
          location: point,
          externalId: null,
          distanceMeters: null,
          matchedRanges: [],
        },
        undefined,
      );
    }

    if (kind === 'saved') {
      const row = await this.prisma.savedPlace.findFirst({
        where: { id: value, userId: userId ?? '__none__' },
      });
      if (!row) throw AppException.notFound('place_not_found', 'Saved place not found');
      return {
        id,
        title: row.label,
        subtitle: row.address,
        category: row.category as PlaceCategory,
        kind: 'saved' as const,
        location: { lat: row.lat, lng: row.lng },
        externalId: null,
        distanceMeters: null,
        matchedRanges: [],
      };
    }

    if (kind === 'recent') {
      const row = await this.prisma.recentPlace.findFirst({
        where: { id: value, userId: userId ?? '__none__' },
      });
      if (!row) throw AppException.notFound('place_not_found', 'Recent place not found');
      return {
        id,
        title: row.title,
        subtitle: row.subtitle,
        category: 'other' as PlaceCategory,
        kind: 'recent' as const,
        location: { lat: row.lat, lng: row.lng },
        externalId: row.externalId,
        distanceMeters: null,
        matchedRanges: [],
      };
    }

    if (kind === 'place') {
      const result = await this.places.details(value, language);
      if (!result) {
        throw AppException.notFound('place_not_found', 'No place matches that identifier');
      }
      return this.fromPlace(result, '');
    }

    if (kind === 'geo') {
      const result = await this.geocoding.details(value, language);
      if (!result) {
        throw AppException.notFound('place_not_found', 'No place matches that identifier');
      }
      return this.fromGeocode(result, '');
    }

    throw AppException.badRequest('invalid_place_id', `Unknown place id prefix "${kind}"`);
  }

  async listSaved(userId: string): Promise<SavedPlace[]> {
    const rows = await this.prisma.savedPlace.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toSavedPlace);
  }

  async createSaved(userId: string, input: SavePlaceDto): Promise<SavedPlace> {
    const row = await this.prisma.savedPlace.create({
      data: {
        userId,
        label: input.label,
        category: input.category ?? 'other',
        lat: input.location.lat,
        lng: input.location.lng,
        address: input.address ?? null,
      },
    });
    return toSavedPlace(row);
  }

  async updateSaved(
    userId: string,
    id: string,
    input: UpdateSavedPlaceDto,
  ): Promise<SavedPlace> {
    const existing = await this.prisma.savedPlace.findFirst({ where: { id, userId } });
    if (!existing) throw AppException.notFound('place_not_found', 'Saved place not found');

    const row = await this.prisma.savedPlace.update({
      where: { id },
      data: {
        label: input.label ?? existing.label,
        category: input.category ?? existing.category,
        lat: input.location?.lat ?? existing.lat,
        lng: input.location?.lng ?? existing.lng,
        address: input.address === undefined ? existing.address : input.address,
      },
    });
    return toSavedPlace(row);
  }

  async deleteSaved(userId: string, id: string): Promise<void> {
    const { count } = await this.prisma.savedPlace.deleteMany({ where: { id, userId } });
    if (count === 0) throw AppException.notFound('place_not_found', 'Saved place not found');
  }

  async listRecent(userId: string, limit = 10): Promise<RecentPlace[]> {
    const rows = await this.prisma.recentPlace.findMany({
      where: { userId },
      orderBy: { lastUsedAt: 'desc' },
      take: limit,
    });
    return rows.map(toRecentPlace);
  }

  /** Called when a place is actually used as an origin or destination. */
  async recordRecent(
    userId: string,
    input: {
      title: string;
      subtitle?: string | null;
      location: LatLng;
      externalId?: string | null;
    },
  ): Promise<RecentPlace> {
    const dedupeKey =
      input.externalId ??
      `${input.location.lat.toFixed(4)},${input.location.lng.toFixed(4)}`;

    const row = await this.prisma.recentPlace.upsert({
      where: { userId_dedupeKey: { userId, dedupeKey } },
      create: {
        userId,
        dedupeKey,
        title: input.title,
        subtitle: input.subtitle ?? null,
        lat: input.location.lat,
        lng: input.location.lng,
        externalId: input.externalId ?? null,
      },
      update: {
        title: input.title,
        subtitle: input.subtitle ?? null,
        lat: input.location.lat,
        lng: input.location.lng,
        useCount: { increment: 1 },
        lastUsedAt: new Date(),
      },
    });
    return toRecentPlace(row);
  }

  async deleteRecent(userId: string, id: string): Promise<void> {
    const { count } = await this.prisma.recentPlace.deleteMany({ where: { id, userId } });
    if (count === 0) throw AppException.notFound('place_not_found', 'Recent place not found');
  }

  private async personalSuggestions(
    userId: string,
    query: string,
    near?: LatLng,
  ): Promise<PlaceSuggestion[]> {
    const [saved, recent] = await Promise.all([
      this.prisma.savedPlace.findMany({ where: { userId } }),
      this.prisma.recentPlace.findMany({
        where: { userId },
        orderBy: { lastUsedAt: 'desc' },
        take: 50,
      }),
    ]);

    const scored: { score: number; suggestion: PlaceSuggestion }[] = [];

    for (const row of saved) {
      const score = matchScore(row.label, row.address, query);
      if (score === null) continue;
      scored.push({
        // Saved places outrank recents at equal textual quality: the user named them.
        score: score + 10,
        suggestion: {
          id: `saved:${row.id}`,
          title: row.label,
          subtitle: row.address,
          category: row.category as PlaceCategory,
          kind: 'saved',
          location: { lat: row.lat, lng: row.lng },
          externalId: null,
          distanceMeters: null,
          matchedRanges: matchedRanges(row.label, query),
        },
      });
    }

    for (const row of recent) {
      const score = matchScore(row.title, row.subtitle, query);
      if (score === null) continue;
      scored.push({
        score: score + Math.min(row.useCount, 5),
        suggestion: {
          id: `recent:${row.id}`,
          title: row.title,
          subtitle: row.subtitle,
          category: 'other',
          kind: 'recent',
          location: { lat: row.lat, lng: row.lng },
          externalId: row.externalId,
          distanceMeters: null,
          matchedRanges: matchedRanges(row.title, query),
        },
      });
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_PERSONAL_RESULTS)
      .map((entry) => this.withDistance(entry.suggestion, near));
  }

  private fromGeocode(result: GeocodeResult, query: string): PlaceSuggestion {
    const [head, ...tail] = result.label.split(',');
    const title = head.trim();
    const subtitle = tail.join(',').trim() || null;

    return {
      id: `geo:${result.placeId}`,
      title,
      subtitle,
      category: categoryFromTypes(result.types),
      kind: 'text',
      location: result.location,
      externalId: result.placeId || null,
      distanceMeters: null,
      matchedRanges: query ? matchedRanges(title, query) : [],
    };
  }

  /** A named POI: the place name is the title, its address the disambiguating subtitle. */
  private fromPlace(result: PlaceResult, query: string): PlaceSuggestion {
    const title = result.name;
    // Drop the address subtitle when it merely repeats the name (Google does this for
    // addresses returned by text search).
    const subtitle =
      result.address && result.address.trim() !== title.trim() ? result.address : null;

    return {
      id: `place:${result.placeId}`,
      title,
      subtitle,
      category: categoryFromPlaceTypes(result.primaryType, result.types),
      kind: 'text',
      location: result.location,
      externalId: result.placeId || null,
      distanceMeters: null,
      matchedRanges: query ? matchedRanges(title, query) : [],
    };
  }

  private withDistance(suggestion: PlaceSuggestion, near?: LatLng): PlaceSuggestion {
    if (!near || !suggestion.location) return suggestion;
    return {
      ...suggestion,
      distanceMeters: Math.round(metersBetween(near, suggestion.location)),
    };
  }
}

/** Two suggestions closer than this with a matching name are treated as the same place. */
const DUP_PROXIMITY_METERS = 45;

/**
 * Removes the same place appearing twice - once from Places, once from geocoding. First by the
 * stable place_id, then by proximity plus a matching name, so a POI and the bare address of the
 * same spot collapse to one (the earlier, richer entry wins) while genuinely distinct nearby
 * places are kept. The first occurrence is kept, and search puts named POIs first.
 */
function dedupe(suggestions: PlaceSuggestion[]): PlaceSuggestion[] {
  const seenIds = new Set<string>();
  const out: PlaceSuggestion[] = [];

  for (const suggestion of suggestions) {
    if (suggestion.externalId && seenIds.has(suggestion.externalId)) continue;

    const duplicate = out.some(
      (kept) =>
        kept.location &&
        suggestion.location &&
        metersBetween(kept.location, suggestion.location) < DUP_PROXIMITY_METERS &&
        titlesMatch(kept.title, suggestion.title),
    );
    if (duplicate) continue;

    if (suggestion.externalId) seenIds.add(suggestion.externalId);
    out.push(suggestion);
  }
  return out;
}

function titlesMatch(a: string, b: string): boolean {
  const fold = (text: string): string =>
    text
      .toLowerCase()
      .replace(/[֑-ׇ]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  const x = fold(a);
  const y = fold(b);
  return x === y || x.includes(y) || y.includes(x);
}

function categoryFromTypes(types: string[]): PlaceCategory {
  if (types.includes('synagogue') || types.includes('place_of_worship')) return 'synagogue';
  if (types.some((type) => ['locality', 'administrative_area_level_1', 'administrative_area_level_2'].includes(type))) {
    return 'city';
  }
  if (types.some((type) => ['street_address', 'route', 'premise', 'subpremise'].includes(type))) {
    return 'address';
  }
  if (types.includes('point_of_interest') || types.includes('establishment')) return 'poi';
  return 'other';
}

/** Maps Places (New) type strings onto our category. primaryType is the strongest signal. */
function categoryFromPlaceTypes(
  primaryType: string | null,
  types: string[],
): PlaceCategory {
  const all = [primaryType, ...types].filter((t): t is string => Boolean(t));
  if (all.some((t) => t === 'synagogue' || t === 'place_of_worship')) return 'synagogue';
  if (all.some((t) => ['locality', 'administrative_area_level_1', 'administrative_area_level_2', 'postal_town', 'sublocality'].includes(t))) {
    return 'city';
  }
  if (all.some((t) => ['street_address', 'route', 'premise', 'subpremise'].includes(t))) {
    return 'address';
  }
  // Everything else the Places API returns is a named point of interest.
  return 'poi';
}

function toSavedPlace(row: {
  id: string;
  label: string;
  category: string;
  lat: number;
  lng: number;
  address: string | null;
  createdAt: Date;
}): SavedPlace {
  return {
    id: row.id,
    label: row.label,
    category: row.category as PlaceCategory,
    location: { lat: row.lat, lng: row.lng },
    address: row.address,
    createdAt: row.createdAt.toISOString(),
  };
}

function toRecentPlace(row: {
  id: string;
  title: string;
  subtitle: string | null;
  lat: number;
  lng: number;
  lastUsedAt: Date;
  useCount: number;
}): RecentPlace {
  return {
    id: row.id,
    title: row.title,
    subtitle: row.subtitle,
    location: { lat: row.lat, lng: row.lng },
    lastUsedAt: row.lastUsedAt.toISOString(),
    useCount: row.useCount,
  };
}
