import type { Lane, LaneIndication } from '@shared';

/**
 * Lane guidance from the OSM `turn:lanes` tags of the way that leads into a manoeuvre. Pure
 * functions; LanesService does the lookups.
 */

const KNOWN: Record<string, LaneIndication> = {
  left: 'left',
  slight_left: 'slight_left',
  sharp_left: 'sharp_left',
  through: 'through',
  right: 'right',
  slight_right: 'slight_right',
  sharp_right: 'sharp_right',
  reverse: 'reverse',
  merge_to_left: 'merge_to_left',
  merge_to_right: 'merge_to_right',
  none: 'none',
};

/** "left|through;right|right" -> lanes, left to right. Empty or unknown markings are 'none'. */
export function parseTurnLanes(value: string): LaneIndication[][] {
  return value.split('|').map((lane) => {
    const indications = lane
      .split(';')
      .map((part) => KNOWN[part.trim().toLowerCase()] ?? null)
      .filter((part): part is LaneIndication => part !== null);
    return indications.length > 0 ? [...new Set(indications)] : ['none'];
  });
}

/**
 * For each manoeuvre action, the lane markings that serve it, in order of preference: the
 * first group that matches any lane decides which lanes are valid. Israel drives on the
 * right, so a U-turn is made from the leftmost lanes.
 */
const VALID_BY_ACTION: Record<string, LaneIndication[][]> = {
  turn_left: [['left'], ['sharp_left'], ['slight_left']],
  sharp_left: [['sharp_left'], ['left']],
  slight_left: [['slight_left'], ['left']],
  keep_left: [['slight_left'], ['left']],
  ramp_left: [['slight_left'], ['left']],
  turn_right: [['right'], ['sharp_right'], ['slight_right']],
  sharp_right: [['sharp_right'], ['right']],
  slight_right: [['slight_right'], ['right']],
  keep_right: [['slight_right'], ['right']],
  ramp_right: [['slight_right'], ['right']],
  continue: [['through'], ['none']],
  uturn: [['reverse'], ['left']],
};

/**
 * Lanes for a manoeuvre, or undefined when the markings cannot say which lanes to use (a
 * single lane, no lane serving the action, or an action lanes do not apply to). Showing
 * nothing is better than showing a wrong lane.
 */
export function lanesForAction(action: string, markings: LaneIndication[][]): Lane[] | undefined {
  if (markings.length < 2) return undefined;
  const groups = VALID_BY_ACTION[action];
  if (!groups) return undefined;
  for (const group of groups) {
    const valid = markings.map((lane) => lane.some((indication) => group.includes(indication)));
    if (valid.some(Boolean)) {
      // Every lane valid tells the driver nothing.
      if (valid.every(Boolean)) return undefined;
      return markings.map((indications, index) => ({ indications, valid: valid[index] }));
    }
  }
  return undefined;
}

export interface TurnLaneWay {
  turnLanes: string | null;
  turnLanesForward: string | null;
  turnLanesBackward: string | null;
  oneway: string | null;
}

/**
 * Which tag applies to traffic moving along (`withDrawing`) or against the way's drawing
 * direction. A one-way way's plain `turn:lanes` describes its only direction of travel; on a
 * two-way way only the directional tags are unambiguous.
 */
export function turnLanesFor(way: TurnLaneWay, withDrawing: boolean): string | null {
  const oneway = (way.oneway ?? '').toLowerCase();
  if (oneway === 'yes' || oneway === 'true' || oneway === '1') {
    return withDrawing ? way.turnLanes ?? way.turnLanesForward : null;
  }
  if (oneway === '-1' || oneway === 'reverse') {
    return withDrawing ? null : way.turnLanes ?? way.turnLanesBackward;
  }
  return withDrawing ? way.turnLanesForward : way.turnLanesBackward;
}
