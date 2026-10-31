import { createHash } from 'node:crypto';

import type { LatLng, Maneuver, ManeuverZone } from '@shared';

/**
 * A maneuver before the route-wide fields are known. Providers produce these; the routing
 * service turns them into the `Maneuver` of the shared contract once the geometry, the
 * distances and the zone annotations are settled.
 */
export interface DraftManeuver {
  instruction: string;
  action: string;
  point: LatLng;
  geometryIndex: number;
  street: string | null;
  /** Road reference number, e.g. "1" or "443". */
  roadRef?: string | null;
  /** Roundabout exit to take, 1-based. */
  exitNumber?: number;
  zone?: ManeuverZone;
}

/**
 * The closed set of action keys the clients know how to draw and speak. Anything a provider
 * returns that is not in this set becomes "continue", never raw provider text.
 */
export const MANEUVER_ACTIONS = [
  'depart',
  'arrive',
  'continue',
  'turn_left',
  'turn_right',
  'slight_left',
  'slight_right',
  'sharp_left',
  'sharp_right',
  'uturn',
  'keep_left',
  'keep_right',
  'roundabout_enter',
  'roundabout_exit',
  'merge',
  'ramp_left',
  'ramp_right',
  'ferry',
] as const;

export type ManeuverAction = (typeof MANEUVER_ACTIONS)[number];

const ACTION_ALIASES: Record<string, ManeuverAction> = {
  depart: 'depart',
  head: 'depart',
  arrive: 'arrive',
  destination: 'arrive',
  arriveleft: 'arrive',
  arriveright: 'arrive',
  continue: 'continue',
  straight: 'continue',
  name_change: 'continue',
  turnleft: 'turn_left',
  turn_left: 'turn_left',
  left: 'turn_left',
  turnright: 'turn_right',
  turn_right: 'turn_right',
  right: 'turn_right',
  turnslightleft: 'slight_left',
  turn_slight_left: 'slight_left',
  slight_left: 'slight_left',
  slightlyleft: 'slight_left',
  turnslightright: 'slight_right',
  turn_slight_right: 'slight_right',
  slight_right: 'slight_right',
  slightlyright: 'slight_right',
  turnsharpleft: 'sharp_left',
  turn_sharp_left: 'sharp_left',
  sharp_left: 'sharp_left',
  quiteleft: 'sharp_left',
  turnsharpright: 'sharp_right',
  turn_sharp_right: 'sharp_right',
  sharp_right: 'sharp_right',
  quiteright: 'sharp_right',
  uturn: 'uturn',
  uturnleft: 'uturn',
  uturnright: 'uturn',
  u_turn_left: 'uturn',
  u_turn_right: 'uturn',
  keepleft: 'keep_left',
  keep_left: 'keep_left',
  forkleft: 'keep_left',
  fork_left: 'keep_left',
  keepright: 'keep_right',
  keep_right: 'keep_right',
  forkright: 'keep_right',
  fork_right: 'keep_right',
  roundaboutenter: 'roundabout_enter',
  roundabout: 'roundabout_enter',
  roundabout_left: 'roundabout_enter',
  roundabout_right: 'roundabout_enter',
  roundaboutexit: 'roundabout_exit',
  roundabout_exit: 'roundabout_exit',
  merge: 'merge',
  merge_left: 'merge',
  merge_right: 'merge',
  ramp: 'ramp_right',
  rampleft: 'ramp_left',
  ramp_left: 'ramp_left',
  rampright: 'ramp_right',
  ramp_right: 'ramp_right',
  exit: 'ramp_right',
  ferry: 'ferry',
  ferryenter: 'ferry',
};

/**
 * Normalises a provider action into a stable key.
 *
 * `direction` covers HERE, which reports the verb and the side in two separate fields
 * ("turn" plus "left"), unlike Google which reports "TURN_LEFT" in one.
 */
export function normalizeAction(raw?: string | null, direction?: string | null): string {
  const base = (raw ?? '').toLowerCase().replace(/[\s-]+/g, '_');
  const side = (direction ?? '').toLowerCase().replace(/[\s-]+/g, '_');

  if (side) {
    const combined = ACTION_ALIASES[`${base}${side}`] ?? ACTION_ALIASES[`${base}_${side}`];
    if (combined) return combined;
  }
  return ACTION_ALIASES[base] ?? ACTION_ALIASES[base.replace(/_/g, '')] ?? 'continue';
}

export const ZONE_ACTIONS = [
  'zone_enter',
  'zone_exit',
  'zone_origin',
  'zone_destination',
] as const;

export function isZoneAction(action: string): boolean {
  return (ZONE_ACTIONS as readonly string[]).includes(action);
}

/**
 * Announced distances are a closed ladder (spec section 15.2), so the clip library stays
 * small. Mirrors DISTANCE_LADDER_METERS in the shared contract, which cannot be imported at
 * runtime because it is a value and the contract is consumed type-only.
 */
export const DISTANCE_LADDER_METERS = [2000, 1000, 800, 500, 300, 200, 100, 50, 0];

const DISTANCE_CLIP_KEYS: Record<number, string> = {
  2000: 'dist.2km',
  1000: 'dist.1km',
  800: 'dist.800m',
  500: 'dist.500m',
  300: 'dist.300m',
  200: 'dist.200m',
  100: 'dist.100m',
  50: 'dist.50m',
  0: 'dist.now',
};

/** Rounds a real distance down to the nearest rung of the ladder. */
export function distanceRung(meters: number): number {
  for (const rung of DISTANCE_LADDER_METERS) {
    if (meters >= rung) return rung;
  }
  return 0;
}

export function distanceClipKey(meters: number): string {
  return DISTANCE_CLIP_KEYS[distanceRung(meters)];
}

export const ALL_DISTANCE_CLIP_KEYS = DISTANCE_LADDER_METERS.map(
  (rung) => DISTANCE_CLIP_KEYS[rung],
);

/**
 * Street names are an open vocabulary, so their clip key is a hash of the name rather than
 * the name itself. A recording can then be replaced without breaking references
 * (spec section 15.3).
 */
export function streetClipKey(street: string): string {
  const normalised = street.trim().replace(/\s+/g, ' ').toLowerCase();
  const hash = createHash('sha1').update(normalised).digest('hex').slice(0, 12);
  return `street.${hash}`;
}

/**
 * Highest roundabout exit with its own ordinal clip ("exit.1" .. "exit.8"). Mirrors
 * ROUNDABOUT_EXIT_KEYS_MAX in the shared contract, which is type-only at runtime here.
 */
const ROUNDABOUT_EXIT_KEYS_MAX = 8;

/**
 * The ordered clips needed to speak one step. The server never returns a finished sentence -
 * the client assembles both the screen text and the audio from this (spec section 15.1).
 */
export function buildVoiceKeys(maneuver: DraftManeuver, distanceMeters: number): string[] {
  if (isZoneAction(maneuver.action)) {
    return [`zone.${maneuver.action.replace('zone_', '')}`];
  }

  const keys: string[] = [];
  if (maneuver.action !== 'depart') {
    keys.push('prefix.in', distanceClipKey(distanceMeters));
  }
  keys.push(`action.${maneuver.action}`);
  if (
    maneuver.action === 'roundabout_enter' &&
    maneuver.exitNumber &&
    maneuver.exitNumber >= 1 &&
    maneuver.exitNumber <= ROUNDABOUT_EXIT_KEYS_MAX
  ) {
    keys.push(`exit.${maneuver.exitNumber}`);
  }
  if (maneuver.street) keys.push(streetClipKey(maneuver.street));
  return keys;
}

/** Finalises drafts into the contract shape: stable ids, distances and voice keys. */
export function finaliseManeuvers(
  routeId: string,
  drafts: DraftManeuver[],
  cumulative: number[],
): Maneuver[] {
  const maneuvers: Maneuver[] = [];
  let previousMeters = 0;

  drafts.forEach((draft, index) => {
    const atMeters = cumulative[Math.min(draft.geometryIndex, cumulative.length - 1)] ?? 0;
    const distanceMeters = Math.max(0, Math.round(atMeters - previousMeters));
    previousMeters = atMeters;

    maneuvers.push({
      id: `${routeId}-m${index}`,
      instruction: draft.instruction,
      action: draft.action,
      point: draft.point,
      distanceMeters,
      geometryIndex: draft.geometryIndex,
      street: draft.street,
      ...(draft.roadRef ? { roadRef: draft.roadRef } : {}),
      ...(draft.exitNumber ? { exitNumber: draft.exitNumber } : {}),
      ...(draft.zone ? { zone: draft.zone } : {}),
      voiceKeys: buildVoiceKeys(draft, distanceMeters),
    });
  });

  return maneuvers;
}

export function collectVoiceKeys(maneuvers: Maneuver[]): string[] {
  return [...new Set(maneuvers.flatMap((maneuver) => maneuver.voiceKeys))];
}
