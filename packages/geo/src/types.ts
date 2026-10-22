export interface LatLng {
  lat: number;
  lng: number;
}

/** GeoJSON coordinate order: [lng, lat]. */
export type LngLat = [lng: number, lat: number];

export interface Bbox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}
