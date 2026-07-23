/**
 * Decoder for Google's "encoded polyline algorithm format" (precision 5), returned by the
 * Routes API in `routes[].polyline.encodedPolyline`.
 *
 * Implemented locally for the same reason as the HERE decoder: no dependency on an
 * unversioned helper package. Format reference:
 * https://developers.google.com/maps/documentation/utilities/polylinealgorithm
 */

const PRECISION = 1e5;

/** Decodes into [lat, lng] pairs, in Google's native order. */
export function decodeEncodedPolyline(encoded: string): [number, number][] {
  const points: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    lat += decodeValue();
    lng += decodeValue();
    points.push([lat / PRECISION, lng / PRECISION]);
  }

  return points;

  function decodeValue(): number {
    let result = 0;
    let shift = 0;
    let byte: number;

    do {
      if (index >= encoded.length) {
        throw new Error('Truncated encoded polyline');
      }
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    // Least significant bit carries the sign (zig-zag encoding).
    return result & 1 ? ~(result >> 1) : result >> 1;
  }
}

/** Convenience: decode straight into GeoJSON [lng, lat] order. */
export function decodeEncodedPolylineToLngLat(encoded: string): [number, number][] {
  return decodeEncodedPolyline(encoded).map(([lat, lng]) => [lng, lat]);
}
