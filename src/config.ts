/** Central place for env access - no secret is ever hardcoded. See .env.example. */

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === '') return fallback;
  return value === 'true' || value === '1';
}

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  port: num(process.env.PORT, 3000),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  databaseUrl:
    process.env.DATABASE_URL ??
    'postgresql://derech:derech@localhost:5432/derech_kohanim',

  /** Comma separated list, or "*" for any origin during development. */
  corsOrigins: (process.env.CORS_ORIGINS ?? '*').split(',').map((o) => o.trim()),

  /**
   * Emails allowed into the admin console (/api/admin), comma separated. Matched
   * case-insensitively against the signed-in user's Google email. Empty means no admins.
   */
  adminEmails: (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
  /** Origin the admin console is served from, added to the CORS allow-list when set. */
  adminOrigin: process.env.ADMIN_ORIGIN ?? '',

  jwtSecret: process.env.JWT_SECRET ?? 'dev-only-insecure-secret-change-me',
  accessTokenTtlSeconds: num(process.env.ACCESS_TOKEN_TTL_SECONDS, 900),
  refreshTokenTtlDays: num(process.env.REFRESH_TOKEN_TTL_DAYS, 30),

  /** Google Identity Services client id, used to verify ID tokens from web and Android. */
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? '',
  /** Extra client ids accepted as audience, e.g. the Android client. */
  googleExtraClientIds: (process.env.GOOGLE_EXTRA_CLIENT_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),

  /**
   * Dev-only shortcut that mints tokens for a demo user without any Google credential.
   * Must stay false in production.
   */
  devLoginEnabled: bool(process.env.AUTH_DEV_LOGIN_ENABLED, false),
  devLoginEmail: process.env.AUTH_DEV_LOGIN_EMAIL ?? 'demo@derech-kohanim.local',

  hereApiKey: process.env.HERE_API_KEY ?? '',
  /** Server-side key for the Google Routes API. NOT the browser Maps JavaScript key. */
  googleRoutesApiKey: process.env.GOOGLE_ROUTES_API_KEY ?? '',
  /** Server-side key for the Google Geocoding API. Defaults to the Routes key. */
  googleGeocodingApiKey:
    process.env.GOOGLE_GEOCODING_API_KEY ?? process.env.GOOGLE_ROUTES_API_KEY ?? '',
  /** Bias address search to this country. */
  geocodingRegion: process.env.GEOCODING_REGION ?? 'il',
  /** Rows older than this are refetched. Google permits 30 days for geocoding results. */
  geocodeCacheTtlDays: num(process.env.GEOCODE_CACHE_TTL_DAYS, 30),

  /**
   * Server-side key for the Places API (New), used to find named POIs by name. Separate API
   * from Routes/Geocoding and must be enabled on the project. Defaults to the Routes key.
   */
  googlePlacesApiKey:
    process.env.GOOGLE_PLACES_API_KEY ?? process.env.GOOGLE_ROUTES_API_KEY ?? '',
  /**
   * Places content has stricter caching rules than geocoding: the stable place_id may be kept
   * indefinitely, but names/addresses are only a short-lived performance cache. Kept short.
   */
  placesCacheTtlDays: num(process.env.PLACES_CACHE_TTL_DAYS, 1),

  /** Server-side key for Google Cloud Text-to-Speech. Defaults to the Routes key. */
  googleTtsApiKey:
    process.env.GOOGLE_TTS_API_KEY ?? process.env.GOOGLE_ROUTES_API_KEY ?? '',
  /**
   * Speech backend: "google" (real Cloud TTS, default) or "offline" (a synthetic tone
   * generator for development and for verifying the store-and-serve pipeline without a paid,
   * enabled API). Offline audio is clearly not speech and is meant only for local use.
   */
  ttsProvider: (process.env.TTS_PROVIDER ?? 'google').toLowerCase(),

  graphHopperApiKey: process.env.GRAPHHOPPER_API_KEY ?? '',
  graphHopperUrl: process.env.GRAPHHOPPER_URL ?? 'https://graphhopper.com/api/1/route',
  graphHopperSelfHosted: bool(process.env.GRAPHHOPPER_SELF_HOSTED, false),

  /**
   * Which engine decides the route shape in the hybrid engine: "graphhopper" (default) or
   * "here". Must be one that blocks polygons natively - Google only prices the time.
   */
  hybridShapeEngine: (process.env.HYBRID_SHAPE_ENGINE ?? 'graphhopper').toLowerCase(),
  provider: (process.env.ROUTING_PROVIDER ?? 'here').toLowerCase(),

  /** Public base url the client uses to download voice clips. */
  voiceBaseUrl: process.env.VOICE_BASE_URL ?? '/api/voice/clips',

  runMigrationsOnBoot: bool(process.env.RUN_MIGRATIONS_ON_BOOT, true),
  seedOnBoot: bool(process.env.SEED_ON_BOOT, true),

  /** Distance from the route line beyond which the driver counts as off route. */
  offRouteThresholdMeters: num(process.env.OFF_ROUTE_THRESHOLD_METERS, 45),
  /** Consecutive off-route reports before a reroute is triggered. */
  offRouteReportsBeforeReroute: num(process.env.OFF_ROUTE_REPORTS_BEFORE_REROUTE, 2),
  /** Distance to the destination that counts as arrival. */
  arrivalThresholdMeters: num(process.env.ARRIVAL_THRESHOLD_METERS, 40),
  /** A zone closer than this ahead of the driver raises an alert. */
  zoneAlertRadiusMeters: num(process.env.ZONE_ALERT_RADIUS_METERS, 400),
};

export type ProviderName = 'here' | 'google' | 'graphhopper' | 'hybrid' | 'mock';

/** A provider is offered only when the credentials it needs are actually present. */
export function isProviderAvailable(name: ProviderName): boolean {
  switch (name) {
    case 'here':
      return Boolean(config.hereApiKey);
    case 'google':
      return Boolean(config.googleRoutesApiKey);
    case 'graphhopper':
      return Boolean(config.graphHopperApiKey) || config.graphHopperSelfHosted;
    case 'hybrid':
      // Needs both halves: an engine that blocks polygons, and Google to price the time.
      return (
        isProviderAvailable(config.hybridShapeEngine === 'here' ? 'here' : 'graphhopper') &&
        isProviderAvailable('google')
      );
    case 'mock':
      return true;
  }
}

/** Every engine name, so a requested one is honoured whether or not it is in the fallback. */
const ALL_PROVIDERS: ProviderName[] = ['here', 'google', 'graphhopper', 'hybrid', 'mock'];

/**
 * Order used when the configured provider has no key. Hybrid is preferred first, in line
 * with the product decision that travel time always comes from Google priced over a
 * polygon-blocking shape.
 */
const FALLBACK_ORDER: ProviderName[] = ['hybrid', 'here', 'graphhopper', 'google', 'mock'];

export function resolveProvider(): ProviderName {
  const requested = config.provider as ProviderName;
  if (ALL_PROVIDERS.includes(requested) && isProviderAvailable(requested)) {
    return requested;
  }
  return FALLBACK_ORDER.find(isProviderAvailable) ?? 'mock';
}
