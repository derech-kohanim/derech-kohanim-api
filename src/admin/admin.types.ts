// Response shapes for the admin console (/api/admin). These are the exact contracts the admin
// web app is built against; keep them in sync with the controllers' documented outputs.

import type { ProviderInfo } from '@shared';

export interface AdminMe {
  email: string;
  isAdmin: true;
}

export interface AdminVoicePack {
  id: string;
  language: string;
  voiceId: string;
  version: number;
  clipCount: number;
  withAudio: number;
  missingAudio: number;
  totalBytes: number;
  updatedAt: string;
}

export interface AdminVoiceClip {
  id: string;
  key: string;
  role: string;
  text: string;
  source: string;
  hash: string;
  durationMs: number;
  hasAudio: boolean;
  sizeBytes: number;
  contentType: string | null;
  url: string;
}

export interface AdminPregenerateSummary {
  generated: number;
  skipped: number;
  failed: number;
}

export interface AdminNavSession {
  id: string;
  routeId: string;
  userId: string | null;
  simulated: boolean;
  status: string;
  /** True once the session ended by reaching the destination, null while it is still live. */
  arrived: boolean | null;
  stringency: string;
  engine: string;
  trafficAware: boolean;
  startedAt: string;
  endedAt: string | null;
  lastLat: number | null;
  lastLng: number | null;
  offRouteCount: number;
  rerouteCount: number;
  /** Distance and duration of the route the session is currently on, when it still exists. */
  distanceMeters: number | null;
  durationSeconds: number | null;
}

export interface AdminLatLng {
  lat: number;
  lng: number;
}

/**
 * One stored route, at the level of detail the debug view needs: what was asked for, what came
 * back, and how far it strayed from the naive route. Geometry itself is summarised by its point
 * count - the full line is available from the route compute payload when it is really wanted.
 */
export interface AdminRouteSummary {
  id: string;
  /** Groups the routes one compute produced; null for rows written before plans were tracked. */
  planId: string | null;
  /** primary | alternative | unavoided. */
  role: string;
  rank: number;
  engine: string;
  distanceMeters: number;
  durationSeconds: number;
  verifiedClean: boolean;
  reason?: string;
  label?: string;
  detourRatio?: number;
  avoidsTolls?: boolean;
  stringency: string;
  mode: string;
  origin: AdminLatLng;
  destination: AdminLatLng;
  avoidDangerZones: boolean;
  avoidTolls: boolean;
  trafficAware: boolean;
  geometryPoints: number;
  maneuverCount: number;
  /** Zones the manoeuvres flagged, so a route through a zone is visible without the geometry. */
  zoneManeuvers: number;
  /** The planner's trace: which strategies were tried, in order. */
  attempts: string[];
  naiveDistanceMeters?: number;
  createdAt: string;
}

/** One leg of a session: the route it started on, then one entry per reroute. */
export interface AdminNavSessionRoute {
  routeId: string;
  /** initial | reroute. */
  reason: string;
  at: string;
  /** True for the route the session is on right now. */
  current: boolean;
  route: AdminRouteSummary | null;
}

export interface AdminNavFeedback {
  id: string;
  /** Null once the route it was left on passed the retention window; the rating itself stays. */
  routeId: string | null;
  userId: string | null;
  rating: string;
  text: string | null;
  createdAt: string;
}

/**
 * Everything needed to judge one navigation run: the session, the route it is on, every route
 * the same compute offered next to it (including the unavoided comparison route), the reroute
 * trail, and any feedback the driver left.
 */
export interface AdminNavSessionDetail {
  session: AdminNavSession;
  /** The route the session is currently navigating. */
  route: AdminRouteSummary | null;
  /**
   * The full plan the chosen route came from, best first. `route.id` identifies which of these
   * the driver actually navigated. Empty when the route predates plan tracking.
   */
  plan: AdminRouteSummary[];
  /** Start, then one entry per reroute, oldest first. */
  legs: AdminNavSessionRoute[];
  feedback: AdminNavFeedback[];
}

export interface AdminUser {
  id: string;
  email: string | null;
  displayName: string | null;
  tier: string;
  providers: string[];
  isAdmin: boolean;
  stringency: string;
  language: string;
  acceptedTermsVersion: string | null;
  acceptedTermsAt: string | null;
  createdAt: string;
  updatedAt: string;
  sessionCount: number;
  routeCount: number;
  feedbackCount: number;
  /** Start of the most recent navigation session, null if the account never navigated. */
  lastSessionAt: string | null;
}

export interface AdminUserDetail extends AdminUser {
  savedPlaceCount: number;
  recentPlaceCount: number;
  /** The account's most recent sessions, newest first. */
  recentSessions: AdminNavSession[];
}

export interface AdminUserList {
  users: AdminUser[];
  /** Total matching the filter, for paging. */
  total: number;
}

/** What the retention sweep removed, per table. */
export interface AdminRetentionResult {
  retentionDays: number;
  cutoff: string;
  navSessions: number;
  routes: number;
  routeComputeStats: number;
}

export interface AdminRouteCompute {
  id: string;
  createdAt: string;
  provider: string;
  engine: string;
  computeMs: number;
  handlingMs: number;
  alternativeCount: number;
  verifiedClean: boolean;
  stringency: string;
  mode: string;
  originLat: number;
  originLng: number;
  destLat: number;
  destLng: number;
  distanceMeters: number | null;
  durationSeconds: number | null;
  avoidDangerZones: boolean;
  avoidTolls: boolean;
  routeId: string | null;
  userId: string | null;
}

export interface AdminRouteComputeDetail extends AdminRouteCompute {
  route: {
    id: string;
    geometryPoints: number;
    distanceMeters: number;
    durationSeconds: number;
    verifiedClean: boolean;
    attempts: string[];
    naiveDistanceMeters?: number;
  } | null;
}

export type BBox = [number, number, number, number];

export interface AdminZoneSummary {
  id: number;
  name: string;
  nameHe: string;
  stringency: string;
  city: string | null;
  street: string | null;
  vertexCount: number;
  bbox: BBox | null;
  updatedAt: string | null;
}

export interface AdminDangerSummary {
  id: number;
  name: string;
  city: string | null;
  vertexCount: number;
  bbox: BBox | null;
}

export interface AdminSystem {
  providers: ProviderInfo[];
  ttsProvider: string;
  counts: {
    voicePacks: number;
    voiceClips: number;
    zones: number;
    dangerZones: number;
    sessionsLive: number;
    sessionsTotal: number;
    computes: number;
    feedback: number;
    users: number;
    /** Deletion requests still waiting for an operator. */
    deletionsPending: number;
  };
  /** Data lifecycle: the configured window and what the last sweep removed. */
  retention: {
    days: number;
    sweepHours: number;
    last: AdminRetentionResult | null;
  };
  versions: {
    zones: number;
    danger: number;
    voicePacks: number;
  };
  uptimeSeconds: number;
}
