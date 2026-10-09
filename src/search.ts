import { config } from './config';
import { pincodeToPoint } from './geocode';
import type { Point } from './geo';
import { enrichHospital, isGoogleBlocked, searchAround } from './googleEnrich';
import { fetchOsmHospitals } from './sources/overpass';
import {
  findNearest,
  isAreaCovered,
  markAreaCovered,
  needsGoogleDetails,
  upsertHospitals,
  type HospitalWithDistance,
} from './store';

export class NotFoundError extends Error {}

export interface SearchParams {
  lat?: number;
  lng?: number;
  pincode?: string;
  radiusKm: number;
  limit: number;
}

type Logger = { info: (obj: object, msg?: string) => void; warn: (obj: object, msg?: string) => void };

const osmInFlight = new Map<string, Promise<void>>();

/** Makes sure OpenStreetMap hospitals for this circle are in the database (fast, ~1-3 s). */
function ensureOsm(center: Point, radiusKm: number): Promise<void> {
  const key = `${center.lat.toFixed(3)},${center.lng.toFixed(3)},${radiusKm}`;
  const running = osmInFlight.get(key);
  if (running) return running;
  const run = (async () => {
    if (await isAreaCovered('osm', center, radiusKm)) return;
    const candidates = await fetchOsmHospitals(center, radiusKm);
    await upsertHospitals(candidates);
    await markAreaCovered('osm', center, radiusKm);
  })().finally(() => osmInFlight.delete(key));
  osmInFlight.set(key, run);
  return run;
}

/**
 * Loads OpenStreetMap hospitals in growing circles (2, 5, 10 km, ... up to the radius) and stops as
 * soon as `limit` are known: in a city the nearest few are a 2 km query away, which is far quicker
 * than downloading every hospital in a 20 km radius. If the radius holds none at all, keeps growing
 * (up to NEAREST_FALLBACK_MAX_KM) to find the nearest ones outside it.
 */
async function loadOsmNearest(center: Point, radiusKm: number, limit: number, deadline: number, log: Logger) {
  const steps = [...[2, 5, 10, 20, 50].filter((r) => r < radiusKm), radiusKm];
  steps.push(...[Math.max(radiusKm * 2, 10), 40, config.nearestFallbackMaxKm].filter((r) => r > radiusKm));
  const circles = [...new Set(steps.map((r) => Math.min(r, config.nearestFallbackMaxKm)))].sort((a, b) => a - b);

  let failed = false;
  for (const r of circles) {
    if (Date.now() >= deadline) break;
    try {
      await ensureOsm(center, r);
    } catch (err) {
      failed = true;
      log.warn({ err, radiusKm: r }, 'OpenStreetMap lookup failed');
    }
    if ((await findNearest(center, Math.min(r, radiusKm), limit)).length >= limit) break;
    // Some (but fewer than `limit`) inside the radius: those are the answer, don't look outside.
    if (r >= radiusKm && (await findNearest(center, radiusKm, 1)).length > 0) break;
  }
  return { failed };
}

/** The `limit` nearest hospitals inside the radius; if there are none, the nearest ones anywhere. */
async function pickNearest(center: Point, radiusKm: number, limit: number) {
  const inside = await findNearest(center, radiusKm, limit);
  if (inside.length > 0) return { hospitals: inside, withinRadius: true };
  return { hospitals: await findNearest(center, config.nearestFallbackMaxKm, limit), withinRadius: false };
}

/** Resolves true if `work` settles before `deadline`, false otherwise (it keeps running regardless). */
function beforeDeadline(work: Promise<unknown>, deadline: number): Promise<boolean> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
  });
  return Promise.race([work.then(() => true), timeout]).finally(() => clearTimeout(timer));
}

function googleMapsUrl(h: HospitalWithDistance): string {
  if (h.google_place_id?.startsWith('ChIJ')) return `https://www.google.com/maps/place/?q=place_id:${h.google_place_id}`;
  if (h.google_url) return h.google_url;
  return `https://www.google.com/maps/search/?api=1&query=${h.lat},${h.lng}`;
}

function present(h: HospitalWithDistance) {
  return {
    id: h.id,
    name: h.name,
    distance_km: Math.round(h.distance_km * 100) / 100,
    address: h.address,
    pincode: h.pincode,
    phones: h.phones,
    website: h.website,
    category: h.category,
    specialties: h.specialties,
    open_24_hours: h.open_24_hours,
    emergency: h.emergency,
    rating: h.rating,
    review_count: h.review_count,
    lat: h.lat,
    lng: h.lng,
    google_maps_url: googleMapsUrl(h),
    sources: h.sources,
    last_updated_at: h.updated_at,
  };
}

/**
 * 1. Load OpenStreetMap hospitals and run one Google Maps search around the user, in parallel.
 * 2. Take the nearest `limit` hospitals.
 * 3. Open Google Maps for just those (in parallel) to fill in full address and phone numbers.
 * Everything is capped at REQUEST_BUDGET_MS; whatever is unfinished completes in the background
 * and is saved for the next request.
 */
export async function searchHospitals(params: SearchParams, log: Logger) {
  const started = Date.now();
  let center: Point;
  let resolvedFrom: 'coordinates' | 'pincode';
  if (params.lat !== undefined && params.lng !== undefined) {
    center = { lat: params.lat, lng: params.lng };
    resolvedFrom = 'coordinates';
  } else {
    const point = await pincodeToPoint(params.pincode!);
    if (!point) throw new NotFoundError(`Could not find a location for pincode ${params.pincode}`);
    center = point;
    resolvedFrom = 'pincode';
  }
  const { radiusKm, limit } = params;
  const deadline = started + config.requestBudgetMs;
  const warnings: string[] = [];

  const useGoogle = config.googleMapsEnabled && !isGoogleBlocked();
  if (config.googleMapsEnabled && !useGoogle) {
    warnings.push('Google Maps is temporarily unavailable; showing OpenStreetMap data only.');
  }

  const timings: Record<string, number> = {};
  const timed = <T>(name: string, work: Promise<T>) => work.finally(() => (timings[name] = Date.now() - started));

  // 1. OpenStreetMap and a Google Maps search, side by side
  const googleSearch = useGoogle
    ? timed('google_search_ms', searchAround(center, radiusKm, log)).catch((err) => {
        log.warn({ err }, 'Google Maps search failed');
        warnings.push('Google Maps search failed; results may be incomplete.');
      })
    : Promise.resolve();
  // The public OpenStreetMap servers are sometimes slow (30 s+). Don't let that hold up the answer:
  // wait a few seconds, then continue with what Google found; OSM finishes in the background.
  let osmFailed = false;
  const osm = timed('osm_ms', loadOsmNearest(center, radiusKm, limit, deadline, log)).then((r) => {
    osmFailed = r.failed;
  });
  const osmReady = await beforeDeadline(osm, Math.min(deadline, started + config.osmWaitMs));
  await beforeDeadline(googleSearch, deadline);
  if (osmFailed) warnings.push('OpenStreetMap lookup failed; results may be incomplete.');

  // 2. The nearest hospitals
  let { hospitals, withinRadius } = await pickNearest(center, radiusKm, limit);

  // 3. Google Maps details for just those. Merging can pull a new hospital into the top list,
  //    so take a second pass if time allows.
  let pending = !osmReady;
  for (let pass = 0; useGoogle && pass < 2; pass++) {
    const todo = hospitals.filter(needsGoogleDetails);
    if (todo.length === 0) break;
    const enriching = Promise.all(
      todo.map((h) =>
        enrichHospital(h).catch((err) => log.warn({ err, hospital: h.name }, 'Google Maps details failed')),
      ),
    );
    const finished = await beforeDeadline(enriching, deadline);
    ({ hospitals, withinRadius } = await pickNearest(center, radiusKm, limit));
    if (!finished) {
      pending = true;
      break;
    }
  }
  timings.enrich_done_ms = Date.now() - started;
  log.info({ timings, pending }, 'Nearby search timings');
  if (pending) {
    warnings.push('Some hospital details were still loading; repeat the request shortly for complete data.');
  }

  const message = withinRadius
    ? undefined
    : hospitals.length > 0
      ? `No hospitals found within ${radiusKm} km. Showing the ${hospitals.length} nearest hospitals instead.`
      : `No hospitals found within ${config.nearestFallbackMaxKm} km.`;

  return {
    query: {
      lat: center.lat,
      lng: center.lng,
      pincode: params.pincode ?? null,
      radius_km: radiusKm,
      resolved_from: resolvedFrom,
    },
    within_radius: withinRadius,
    ...(message && { message }),
    ...(warnings.length > 0 && { warnings }),
    took_ms: Date.now() - started,
    count: hospitals.length,
    hospitals: hospitals.map(present),
  };
}
