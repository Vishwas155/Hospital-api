const EARTH_RADIUS_KM = 6371.0088;
const KM_PER_DEG_LAT = 111.32;

export interface Point {
  lat: number;
  lng: number;
}

// Generous bounding box around India (mainland + Andaman & Nicobar + Lakshadweep).
export const INDIA_BOUNDS = { minLat: 6.4, maxLat: 37.2, minLng: 68.0, maxLng: 97.5 };

export function isInIndia(lat: number, lng: number): boolean {
  return (
    lat >= INDIA_BOUNDS.minLat && lat <= INDIA_BOUNDS.maxLat && lng >= INDIA_BOUNDS.minLng && lng <= INDIA_BOUNDS.maxLng
  );
}

const rad = (deg: number) => (deg * Math.PI) / 180;

export function haversineKm(a: Point, b: Point): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function boundingBox(center: Point, radiusKm: number) {
  const dLat = radiusKm / KM_PER_DEG_LAT;
  const dLng = radiusKm / (KM_PER_DEG_LAT * Math.max(0.01, Math.cos(rad(center.lat))));
  return { minLat: center.lat - dLat, maxLat: center.lat + dLat, minLng: center.lng - dLng, maxLng: center.lng + dLng };
}

/** Google Maps zoom level at which a `sizeKm` square fits in roughly `viewportPx` pixels. */
export function zoomForArea(sizeKm: number, lat: number, viewportPx = 900): number {
  const metersPerPx = (sizeKm * 1000) / viewportPx;
  const zoom = Math.floor(Math.log2((156543.03392 * Math.cos(rad(lat))) / metersPerPx));
  return Math.min(17, Math.max(10, zoom));
}
