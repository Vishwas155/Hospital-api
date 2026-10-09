import { config } from '../config';
import type { Point } from '../geo';
import { fetchJson, HttpError, sleep } from '../http';
import { extractPincode, parsePhoneList, titleCase, uniq } from '../normalize';
import type { HospitalCandidate } from '../types';

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

function buildAddress(tags: Record<string, string>): string | null {
  if (tags['addr:full']) {
    const full = tags['addr:full'];
    const pin = tags['addr:postcode'];
    return pin && !full.includes(pin) ? `${full}, ${pin}` : full;
  }
  const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(', ');
  const parts = [
    street,
    tags['addr:suburb'],
    tags['addr:city'] ?? tags['addr:district'],
    [tags['addr:state'], tags['addr:postcode']].filter(Boolean).join(' '),
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

function toCandidate(el: OverpassElement): HospitalCandidate | null {
  const tags = el.tags ?? {};
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  const name = tags.name ?? tags['name:en'];
  if (!name || lat === undefined || lng === undefined) return null;

  const address = buildAddress(tags);
  const specialties = (tags['healthcare:speciality'] ?? '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s && s !== 'general')
    .map(titleCase);

  return {
    source: 'osm',
    name: name.trim(),
    lat,
    lng,
    address,
    pincode: tags['addr:postcode']?.match(/^[1-9]\d{5}$/) ? tags['addr:postcode'] : extractPincode(address),
    phones: uniq(
      ['phone', 'contact:phone', 'mobile', 'contact:mobile'].flatMap((k) => parsePhoneList(tags[k])),
    ),
    website: tags.website ?? tags['contact:website'] ?? null,
    category: tags['healthcare'] === 'hospital' || tags['amenity'] === 'hospital' ? 'Hospital' : null,
    specialties: uniq(specialties),
    open24h: tags.opening_hours === '24/7' ? true : null,
    emergency: tags.emergency === 'yes' ? true : tags.emergency === 'no' ? false : null,
    osmId: `${el.type}/${el.id}`,
  };
}

const RETRY_DELAYS_MS = [2_000, 6_000];
const isRetryable = (err: unknown) => err instanceof HttpError && [429, 502, 503, 504].includes(err.status);

async function queryOverpass(query: string, timeoutMs: number): Promise<OverpassElement[]> {
  const failures: string[] = [];
  for (const url of config.overpassUrls) {
    for (let attempt = 0; ; attempt++) {
      try {
        const data = await fetchJson<{ elements: OverpassElement[] }>(
          url,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `data=${encodeURIComponent(query)}`,
          },
          timeoutMs,
        );
        return data.elements;
      } catch (err) {
        // overpass-api.de allows 2 concurrent queries per IP and answers 429 when they're busy.
        if (isRetryable(err) && attempt < RETRY_DELAYS_MS.length) {
          await sleep(RETRY_DELAYS_MS[attempt]);
          continue;
        }
        failures.push(err instanceof Error ? err.message : String(err));
        break;
      }
    }
  }
  throw new Error(`All Overpass endpoints failed: ${failures.join('; ') || 'none configured'}`);
}

// Overpass servers allow 2 concurrent queries per IP; keep small area queries to one at a time
// so a weekly India import (which runs outside this queue) always has the other slot.
let overpassChain: Promise<unknown> = Promise.resolve();

/** Every hospital OpenStreetMap knows about within `radiusKm` of `center`. */
export async function fetchOsmHospitals(center: Point, radiusKm: number): Promise<HospitalCandidate[]> {
  const around = `around:${Math.round(radiusKm * 1000)},${center.lat},${center.lng}`;
  const query = `[out:json][timeout:25];(nwr["amenity"="hospital"](${around});nwr["healthcare"="hospital"](${around}););out center tags;`;
  const run = overpassChain.then(() => queryOverpass(query, 20_000));
  overpassChain = run.catch(() => {});
  const elements = await run;
  return elements.map(toCandidate).filter((c): c is HospitalCandidate => c !== null);
}

/** Every hospital in India on OpenStreetMap (~56k, ~20 MB; takes about a minute). */
export async function fetchAllIndiaHospitals(): Promise<HospitalCandidate[]> {
  const query =
    '[out:json][timeout:300];area["ISO3166-1"="IN"][admin_level=2]->.in;' +
    '(nwr["amenity"="hospital"](area.in);nwr["healthcare"="hospital"](area.in););out center tags;';
  const elements = await queryOverpass(query, 330_000);
  return elements.map(toCandidate).filter((c): c is HospitalCandidate => c !== null);
}
