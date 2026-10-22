import type { LngLat } from './types';

function encodeValue(value: number): string {
  let v = value < 0 ? ~(value << 1) : value << 1;
  let out = '';
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  return out + String.fromCharCode(v + 63);
}

/** Encode [lng, lat] points as a Google/OSRM polyline (lat first in the format). */
export function encodePolyline(points: LngLat[], precision = 5): string {
  const factor = 10 ** precision;
  let prevLat = 0;
  let prevLng = 0;
  let out = '';
  for (const [lng, lat] of points) {
    const latI = Math.round(lat * factor);
    const lngI = Math.round(lng * factor);
    out += encodeValue(latI - prevLat) + encodeValue(lngI - prevLng);
    prevLat = latI;
    prevLng = lngI;
  }
  return out;
}

/** Decode a Google/OSRM polyline into [lng, lat] points. */
export function decodePolyline(str: string, precision = 5): LngLat[] {
  const factor = 10 ** precision;
  const points: LngLat[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  const readValue = (): number => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };

  while (index < str.length) {
    lat += readValue();
    lng += readValue();
    points.push([lng / factor, lat / factor]);
  }
  return points;
}
