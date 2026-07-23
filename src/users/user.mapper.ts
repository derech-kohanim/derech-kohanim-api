import type { User as UserRow } from '@prisma/client';

import type { AuthProvider, User, UserPreferences, UserTier } from '@shared';

export const DEFAULT_PREFERENCES: UserPreferences = {
  language: 'he',
  theme: 'system',
  stringency: 'basic',
  trafficAware: true,
  avoidTolls: false,
  voiceEnabled: true,
  voiceId: 'he-default',
  units: 'metric',
};

/** Unknown or missing keys fall back to the defaults, so an older row still deserialises. */
export function toPreferences(raw: unknown): UserPreferences {
  const value = (raw ?? {}) as Partial<UserPreferences>;
  return {
    language: value.language === 'en' ? 'en' : 'he',
    theme:
      value.theme === 'light' || value.theme === 'dark' || value.theme === 'system'
        ? value.theme
        : DEFAULT_PREFERENCES.theme,
    stringency:
      value.stringency === 'taharat' || value.stringency === 'machmirim'
        ? value.stringency
        : 'basic',
    trafficAware: value.trafficAware ?? DEFAULT_PREFERENCES.trafficAware,
    // Missing on rows written before toll avoidance existed - default rather than error.
    avoidTolls: value.avoidTolls ?? DEFAULT_PREFERENCES.avoidTolls,
    voiceEnabled: value.voiceEnabled ?? DEFAULT_PREFERENCES.voiceEnabled,
    voiceId: value.voiceId ?? DEFAULT_PREFERENCES.voiceId,
    units: 'metric',
  };
}

export function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    tier: row.tier as UserTier,
    providers: row.providers as AuthProvider[],
    preferences: toPreferences(row.preferences),
    acceptedTermsVersion: row.acceptedTermsVersion,
    createdAt: row.createdAt.toISOString(),
  };
}
