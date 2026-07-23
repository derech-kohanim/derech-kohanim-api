/**
 * Decoder for HERE's "flexible polyline" encoding (the format returned by Routing API v8
 * in `sections[].polyline`).
 *
 * Implemented locally rather than pulled from npm so the POC has no dependency on an
 * unversioned helper package. Format reference:
 * https://github.com/heremaps/flexible-polyline
 */

/**
 * URL-safe base64 alphabet used by the format: A-Z, a-z, 0-9, then '-' (62) and '_' (63).
 *
 * The order of the last two characters matters and is easy to get backwards. They encode
 * 5-bit chunks 30 and 31, so a swap corrupts only the occasional coordinate - the route
 * still looks mostly right while a handful of points fly off the map. Verified against
 * HERE's own `section.departure.place.location`.
 */
const ENCODING_TABLE =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const DECODING_TABLE = new Map<string, number>(
  [...ENCODING_TABLE].map((char, value) => [char, value]),
);

const FORMAT_VERSION = 1;

function decodeChar(char: string): number {
  const value = DECODING_TABLE.get(char);
  if (value === undefined) {
    throw new Error(`Invalid character in flexible polyline: "${char}"`);
  }
  return value;
}

/** Base64-ish varint decode into a flat list of unsigned integers. */
function decodeUnsignedValues(encoded: string): number[] {
  const values: number[] = [];
  let result = 0;
  let shift = 0;
  for (const char of encoded) {
    const value = decodeChar(char);
    // Plain arithmetic (not `<<`) so values beyond 2^31 stay exact.
    result += (value & 0x1f) * Math.pow(2, shift);
    if ((value & 0x20) === 0) {
      values.push(result);
      result = 0;
      shift = 0;
    } else {
      shift += 5;
    }
  }
  return values;
}

/** Zig-zag decode. */
function toSigned(value: number): number {
  return value % 2 === 1 ? -(value + 1) / 2 : value / 2;
}

export interface DecodedPolyline {
  precision: number;
  /** [lat, lng] pairs, in HERE's native order. */
  points: [number, number][];
}

export function decodeFlexiblePolyline(encoded: string): DecodedPolyline {
  const values = decodeUnsignedValues(encoded);
  if (values.length < 2) throw new Error('Flexible polyline too short');

  const version = values[0];
  if (version !== FORMAT_VERSION) {
    throw new Error(`Unsupported flexible polyline version: ${version}`);
  }

  const header = values[1];
  const precision = header & 15;
  const thirdDim = (header >> 4) & 7; // 0 = none, otherwise elevation/altitude/level
  const factor = Math.pow(10, precision);

  const stride = thirdDim ? 3 : 2;
  const points: [number, number][] = [];
  let lat = 0;
  let lng = 0;

  for (let i = 2; i + stride - 1 < values.length; i += stride) {
    lat += toSigned(values[i]);
    lng += toSigned(values[i + 1]);
    points.push([lat / factor, lng / factor]);
  }

  return { precision, points };
}

/** Convenience: decode straight into GeoJSON [lng, lat] order. */
export function decodeToLngLat(encoded: string): [number, number][] {
  return decodeFlexiblePolyline(encoded).points.map(([lat, lng]) => [lng, lat]);
}
