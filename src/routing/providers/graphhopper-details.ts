import type { SpeedLimitSegment } from '@shared';

/** A GraphHopper path detail: [fromIndex, toIndex, value], toIndex exclusive of the next. */
export type PathDetail<T> = [number, number, T];

/** The built-up-area limit in Israel, used when the area is known but no limit is. */
export const URBAN_DEFAULT_KMH = 50;

/**
 * Merges the speed-related path details into contiguous speed-limit segments.
 *
 * - `max_speed` is the limit GraphHopper stored for the edge. With the max-speed calculator
 *   enabled it is filled from the country's legal defaults when OSM has no sign.
 * - `max_speed_estimated` is true exactly when that value came from the calculator, which is
 *   what separates a mapped sign from a legal estimate.
 * - `urban_density` marks built-up stretches; where no limit is known at all, a built-up
 *   stretch gets the urban default rather than nothing.
 *
 * A null or infinite limit stays null - the client then shows no sign rather than a guess.
 */
export function toSpeedLimits(
  maxSpeed: PathDetail<number | null>[] | undefined,
  estimated: PathDetail<boolean | null>[] | undefined,
  urbanDensity: PathDetail<string | null>[] | undefined,
): SpeedLimitSegment[] | undefined {
  if (!maxSpeed || maxSpeed.length === 0) return undefined;

  const boundaries = new Set<number>();
  for (const list of [maxSpeed, estimated ?? [], urbanDensity ?? []]) {
    for (const [from, to] of list) {
      boundaries.add(from);
      boundaries.add(to);
    }
  }
  const points = [...boundaries].sort((a, b) => a - b);

  const segments: SpeedLimitSegment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i];
    const to = points[i + 1];
    if (to <= from) continue;

    const rawLimit = valueAt(maxSpeed, from);
    const isEstimate = valueAt(estimated ?? [], from) === true;
    const density = valueAt(urbanDensity ?? [], from);
    const urban = density === 'residential' || density === 'city';

    let kmh: number | null =
      typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0 && rawLimit < 200
        ? Math.round(rawLimit)
        : null;
    let source: SpeedLimitSegment['source'] = isEstimate ? 'estimated' : 'sign';
    if (kmh === null) {
      source = urban ? 'urban_default' : 'estimated';
      if (urban) kmh = URBAN_DEFAULT_KMH;
    }

    const previous = segments[segments.length - 1];
    if (
      previous &&
      previous.toIndex === from &&
      previous.kmh === kmh &&
      previous.source === source &&
      Boolean(previous.urban) === urban
    ) {
      previous.toIndex = to;
    } else {
      segments.push({ fromIndex: from, toIndex: to, kmh, source, ...(urban ? { urban } : {}) });
    }
  }
  return segments.length > 0 ? segments : undefined;
}

/** The OSM way id detail, with the ids as plain numbers. */
export function toWayIds(
  detail: PathDetail<number | null>[] | undefined,
): [number, number, number][] | undefined {
  if (!detail || detail.length === 0) return undefined;
  const out: [number, number, number][] = [];
  for (const [from, to, id] of detail) {
    if (typeof id === 'number' && id > 0) out.push([from, to, id]);
  }
  return out.length > 0 ? out : undefined;
}

function valueAt<T>(detail: PathDetail<T>[], index: number): T | undefined {
  for (const [from, to, value] of detail) {
    if (index >= from && index < to) return value;
  }
  return undefined;
}
