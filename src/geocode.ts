import { config } from './config';
import { pool } from './db';
import { isInIndia, type Point } from './geo';
import { fetchJson, sleep } from './http';
import { extractPincode } from './normalize';

interface NominatimPlace {
  lat: string;
  lon: string;
  address?: { postcode?: string };
}

interface IndiaPostResponse {
  Status: string;
  PostOffice: { Name: string; District: string; State: string }[] | null;
}

// Nominatim allows at most 1 request per second; queue every call behind the previous one.
let nominatimChain: Promise<unknown> = Promise.resolve();
let lastNominatimCall = 0;

function nominatim<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = `${config.nominatimUrl}${path}?${new URLSearchParams({ format: 'jsonv2', ...params })}`;
  const run = nominatimChain.then(async () => {
    const wait = lastNominatimCall + 1100 - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await fetchJson<T>(url);
    } finally {
      lastNominatimCall = Date.now();
    }
  });
  nominatimChain = run.catch(() => {});
  return run;
}

async function cached<T>(key: string, compute: () => Promise<T | null>): Promise<T | null> {
  const hit = await pool.query<{ value: T }>('SELECT value FROM geocode_cache WHERE key = $1', [key]);
  if (hit.rowCount) return hit.rows[0].value;
  const value = await compute();
  if (value !== null) {
    await pool.query(
      'INSERT INTO geocode_cache (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2, created_at = now()',
      [key, JSON.stringify(value)],
    );
  }
  return value;
}

function toPoint(place: NominatimPlace | undefined): Point | null {
  if (!place) return null;
  const p = { lat: Number(place.lat), lng: Number(place.lon) };
  return Number.isFinite(p.lat) && Number.isFinite(p.lng) && isInIndia(p.lat, p.lng) ? p : null;
}

/**
 * Center point of an Indian pincode. Tries OpenStreetMap's postcode data first; if the pincode
 * isn't mapped there, looks up its post offices with India Post and geocodes those instead.
 */
export function pincodeToPoint(pincode: string): Promise<Point | null> {
  return cached(`pin:${pincode}`, async () => {
    const direct = await nominatim<NominatimPlace[]>('/search', { postalcode: pincode, country: 'in', limit: '1' });
    const point = toPoint(direct[0]);
    if (point) return point;

    const post = await fetchJson<IndiaPostResponse[]>(`https://api.postalpincode.in/pincode/${pincode}`);
    const offices = post[0]?.Status === 'Success' ? (post[0].PostOffice ?? []) : [];
    for (const office of offices.slice(0, 3)) {
      const found = await nominatim<NominatimPlace[]>('/search', {
        q: `${office.Name}, ${office.District}, ${office.State}, India`,
        countrycodes: 'in',
        limit: '1',
      });
      const p = toPoint(found[0]);
      if (p) return p;
    }
    return null;
  });
}

export function pointToPincode(p: Point): Promise<string | null> {
  return cached(`rev:${p.lat.toFixed(3)},${p.lng.toFixed(3)}`, async () => {
    const place = await nominatim<NominatimPlace>('/reverse', {
      lat: String(p.lat),
      lon: String(p.lng),
      zoom: '18',
      addressdetails: '1',
    });
    return extractPincode(place.address?.postcode);
  });
}
