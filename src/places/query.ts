import type { LatLng } from '@shared';

/** Same text typed with different spacing or case must hit the same cache row. */
export function normaliseQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ').toLowerCase();
}

const COORDINATE_PATTERN =
  /^\s*(-?\d{1,3}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

/**
 * Coordinates are classified by the server, not the client, so every platform behaves
 * identically - and a coordinate pair never costs an upstream call.
 */
export function parseCoordinates(query: string): LatLng | null {
  const match = COORDINATE_PATTERN.exec(query);
  if (!match) return null;

  const lat = Number(match[1]);
  const lng = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  // A bare integer pair like "5 7" is far more likely to be a house number than a location.
  if (!match[1].includes('.') && !match[2].includes('.')) return null;

  return { lat, lng };
}

export function formatCoordinates(point: LatLng): string {
  return `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
}

/** Punctuation and Hebrew niqqud are ignored when matching, but positions are preserved. */
function foldForMatching(text: string): string {
  return text.toLowerCase().replace(/[֑-ׇ]/g, ' ');
}

/**
 * Character ranges in `title` that the query matched, so the client can highlight them.
 * Every whitespace-separated token is matched independently and overlapping hits merge.
 */
export function matchedRanges(
  title: string,
  query: string,
): { start: number; length: number }[] {
  const haystack = foldForMatching(title);
  const tokens = foldForMatching(query)
    .split(/[\s,]+/)
    .filter((token) => token.length > 0);

  const ranges: { start: number; length: number }[] = [];
  for (const token of tokens) {
    let from = 0;
    for (;;) {
      const index = haystack.indexOf(token, from);
      if (index === -1) break;
      ranges.push({ start: index, length: token.length });
      from = index + token.length;
    }
  }

  return mergeRanges(ranges);
}

function mergeRanges(
  ranges: { start: number; length: number }[],
): { start: number; length: number }[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged = [sorted[0]];

  for (const range of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    const lastEnd = last.start + last.length;
    if (range.start <= lastEnd) {
      last.length = Math.max(lastEnd, range.start + range.length) - last.start;
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/**
 * How well a stored place matches what the user typed. Higher is better, null means no
 * match at all. A prefix hit outranks a hit in the middle of the text, and a hit in the
 * title outranks one that only appears in the subtitle.
 */
export function matchScore(
  title: string,
  subtitle: string | null,
  query: string,
): number | null {
  const needle = foldForMatching(normaliseQuery(query));
  if (needle.length === 0) return 0;

  const foldedTitle = foldForMatching(title);
  const foldedSubtitle = subtitle ? foldForMatching(subtitle) : '';

  if (foldedTitle.startsWith(needle)) return 100;
  if (foldedTitle.includes(needle)) return 70;

  const tokens = needle.split(/[\s,]+/).filter(Boolean);
  const inTitle = tokens.filter((token) => foldedTitle.includes(token)).length;
  if (inTitle === tokens.length && tokens.length > 0) return 55;

  if (foldedSubtitle.includes(needle)) return 40;
  const inSubtitle = tokens.filter((token) => foldedSubtitle.includes(token)).length;
  if (inTitle + inSubtitle === tokens.length && tokens.length > 0) return 25;

  return null;
}
