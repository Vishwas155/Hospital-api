import { withPage } from './browser';
import { config } from './config';
import { pointToPincode } from './geocode';
import { haversineKm, zoomForArea, type Point } from './geo';
import { isHospitalCategory, nameSimilarity } from './normalize';
import { GoogleBlockedError, scrapePlace, searchPlaces, type GmapsPlace } from './sources/googleMaps';
import {
  isAreaCovered,
  linkGooglePlace,
  markAreaCovered,
  markGoogleChecked,
  upsertHospital,
  upsertHospitals,
} from './store';
import type { HospitalCandidate, HospitalRow } from './types';

type Logger = { info: (obj: object, msg?: string) => void };

// A Google Maps search around a point is reused for requests within this distance of it.
const AREA_REUSE_KM = 1;

let blockedUntil = 0;

export function isGoogleBlocked(): boolean {
  return Date.now() < blockedUntil;
}

// Requests that need the same Google Maps work at the same time share one run of it.
const inFlight = new Map<string, Promise<void>>();

function once(key: string, work: () => Promise<void>): Promise<void> {
  const running = inFlight.get(key);
  if (running) return running;
  const run = work()
    .catch((err) => {
      if (err instanceof GoogleBlockedError) blockedUntil = Date.now() + config.googleBlockCooldownMin * 60_000;
      throw err;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

function toCandidate(p: GmapsPlace): HospitalCandidate {
  return {
    source: 'google_maps',
    name: p.name,
    lat: p.lat,
    lng: p.lng,
    address: p.address,
    phones: p.phones,
    website: p.website,
    category: p.category,
    specialties: [],
    open24h: p.open24h,
    rating: p.rating,
    reviewCount: p.reviewCount,
    googlePlaceId: p.placeId,
    googleUrl: p.href,
    googleDetailed: p.detailed,
  };
}

/**
 * One Google Maps "hospitals" search centered on the user, saving every hospital in the result list
 * (name, position, phone and short address from the result cards). If it finds nothing inside the
 * radius, searches "hospitals in <pincode>" for the user's pincode as well.
 */
export function searchAround(center: Point, radiusKm: number, log: Logger): Promise<void> {
  return once(`area:${center.lat.toFixed(3)},${center.lng.toFixed(3)}`, async () => {
    if (await isAreaCovered('google_maps', center, 0)) return;

    // A ~4 km window: Google lists what's in view first, and the nearest few are what we need.
    const zoom = zoomForArea(Math.min(radiusKm * 2, 4), center.lat);
    const useful = (places: GmapsPlace[]) =>
      places.filter((p) => isHospitalCategory(p.category) && haversineKm(center, p) <= config.nearestFallbackMaxKm);

    let hospitals = useful(await withPage((page) => searchPlaces(page, 'hospitals', { ...center, zoom }, 1)));
    if (!hospitals.some((p) => haversineKm(center, p) <= radiusKm)) {
      const pincode = await pointToPincode(center).catch(() => null);
      if (pincode) {
        log.info({ pincode }, 'No hospitals found by coordinates; searching Google Maps by pincode');
        const byPincode = await withPage((page) => searchPlaces(page, `hospitals in ${pincode}`, { ...center, zoom: 13 }));
        hospitals = [...hospitals, ...useful(byPincode)];
      }
    }

    await upsertHospitals(hospitals.map(toCandidate));
    await markAreaCovered('google_maps', center, AREA_REUSE_KM);
  });
}

/**
 * Fills in one stored hospital from Google Maps: reads its place page (full address, every phone
 * number, website), or, for a hospital only OpenStreetMap knows, finds it on Google Maps by name first.
 */
export function enrichHospital(row: HospitalRow): Promise<void> {
  return once(`hospital:${row.id}`, async () => {
    if (row.google_url) {
      const place = await withPage((page) => scrapePlace(page, row.google_url!));
      if (place) await upsertHospital(toCandidate(place));
      else await markGoogleChecked(row.id);
      return;
    }

    const results = await withPage((page) => searchPlaces(page, row.name, { lat: row.lat, lng: row.lng, zoom: 17 }));
    const match = results
      .filter((p) => haversineKm(row, p) <= 0.3 && nameSimilarity(row.name, p.name) >= 0.5)
      .sort((a, b) => haversineKm(row, a) - haversineKm(row, b))[0];
    if (!match) {
      await markGoogleChecked(row.id);
      return;
    }
    const place = match.detailed ? match : ((await withPage((page) => scrapePlace(page, match.href))) ?? match);
    await linkGooglePlace(row, toCandidate(place));
  });
}
