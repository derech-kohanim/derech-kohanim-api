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
  startedAt: string;
  endedAt: string | null;
  lastLat: number | null;
  lastLng: number | null;
  offRouteCount: number;
  rerouteCount: number;
}

export interface AdminRouteSummary {
  id: string;
  engine: string;
  distanceMeters: number;
  durationSeconds: number;
  verifiedClean: boolean;
  reason?: string;
  stringency: string;
  mode: string;
  createdAt: string;
}

export interface AdminNavFeedback {
  id: string;
  routeId: string;
  userId: string | null;
  rating: string;
  text: string | null;
  createdAt: string;
}

export interface AdminNavSessionDetail {
  session: AdminNavSession;
  route: AdminRouteSummary | null;
  feedback: AdminNavFeedback[];
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
  };
  versions: {
    zones: number;
    danger: number;
    voicePacks: number;
  };
  uptimeSeconds: number;
}
