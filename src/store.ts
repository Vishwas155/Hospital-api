import { config } from './config';
import { pool } from './db';
import { boundingBox, haversineKm, type Point } from './geo';
import { extractPincode, nameSimilarity, pickAddress, uniq } from './normalize';
import type { HospitalCandidate, HospitalRow, Source } from './types';

export type HospitalWithDistance = HospitalRow & { distance_km: number };

const COLUMNS = `id, name, address, pincode, phones, website, category, specialties, open_24_hours, emergency,
  rating, review_count, lat, lng, osm_id, google_place_id, google_url, sources, google_details_at,
  google_checked_at, updated_at`;

/** Hospitals within `maxKm` of `center`, nearest first. */
export async function findNearest(center: Point, maxKm: number, limit: number): Promise<HospitalWithDistance[]> {
  const box = boundingBox(center, maxKm);
  const { rows } = await pool.query<HospitalWithDistance>(
    `SELECT * FROM (
       SELECT ${COLUMNS}, haversine_km($1, $2, lat, lng) AS distance_km
       FROM hospitals
       WHERE lat BETWEEN $3 AND $4 AND lng BETWEEN $5 AND $6
     ) h
     WHERE distance_km <= $7
     ORDER BY distance_km
     LIMIT $8`,
    [center.lat, center.lng, box.minLat, box.maxLat, box.minLng, box.maxLng, maxKm, limit],
  );
  return rows;
}

// ---------- coverage ----------

/** True when a still-fresh search for `source` already covered this whole circle. */
export async function isAreaCovered(source: Source, center: Point, radiusKm: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM covered_areas
     WHERE source = $1 AND scraped_at > now() - ($5 * interval '1 day')
       AND haversine_km(lat, lng, $2, $3) + $4 <= radius_km + 0.001
     LIMIT 1`,
    [source, center.lat, center.lng, radiusKm, config.cacheTtlDays],
  );
  return (rowCount ?? 0) > 0;
}

export async function markAreaCovered(source: Source, center: Point, radiusKm: number): Promise<void> {
  await pool.query('INSERT INTO covered_areas (source, lat, lng, radius_km) VALUES ($1, $2, $3, $4)', [
    source,
    center.lat,
    center.lng,
    radiusKm,
  ]);
}

const isFresh = (at: Date | null) => !!at && Date.now() - at.getTime() < config.cacheTtlDays * 86_400_000;

/** True when the hospital still needs a Google Maps visit (no recent place-page read or lookup). */
export function needsGoogleDetails(row: HospitalRow): boolean {
  return !isFresh(row.google_details_at) && !isFresh(row.google_checked_at);
}

/** Records a Google Maps lookup that found nothing, so it isn't retried until the cache expires. */
export async function markGoogleChecked(id: string): Promise<void> {
  await pool.query('UPDATE hospitals SET google_checked_at = now() WHERE id = $1', [id]);
}

// ---------- merging ----------

/** Same hospital if close together and the names (or a phone number) agree. */
function isSameHospital(row: HospitalRow, c: HospitalCandidate): boolean {
  if (row.osm_id && c.osmId && row.osm_id !== c.osmId) return false;
  const meters = haversineKm(row, c) * 1000;
  const similarity = nameSimilarity(row.name, c.name);
  const sharesPhone = c.phones.some((p) => row.phones.includes(p));
  if (row.google_place_id && c.googlePlaceId && row.google_place_id !== c.googlePlaceId) {
    // Google often has several listings for one hospital ("Fortis Hospital Cunningham Road",
    // "Best Emergency Hospital in Bangalore", ...) pinned to the same spot.
    return meters <= 30 && (sharesPhone || similarity >= 0.9);
  }
  return (meters <= 150 && (sharesPhone || similarity >= 0.75)) || (meters <= 60 && similarity >= 0.5);
}

// Grid cells of ~200 m, so finding duplicates only compares hospitals in neighbouring cells.
const CELL_DEG = 0.002;
const cellOf = (p: Point) => [Math.floor(p.lat / CELL_DEG), Math.floor(p.lng / CELL_DEG)];

/** In-memory index of stored hospitals, used to match a batch of candidates without a query each. */
class HospitalIndex {
  private byGoogle = new Map<string, HospitalRow>();
  private byOsm = new Map<string, HospitalRow>();
  private cells = new Map<string, Set<HospitalRow>>();

  constructor(rows: HospitalRow[]) {
    for (const row of rows) this.add(row);
  }

  add(row: HospitalRow): void {
    if (row.google_place_id) this.byGoogle.set(row.google_place_id, row);
    if (row.osm_id) this.byOsm.set(row.osm_id, row);
    const key = cellOf(row).join(':');
    if (!this.cells.has(key)) this.cells.set(key, new Set());
    this.cells.get(key)!.add(row);
  }

  remove(row: HospitalRow): void {
    if (row.google_place_id && this.byGoogle.get(row.google_place_id) === row) this.byGoogle.delete(row.google_place_id);
    if (row.osm_id && this.byOsm.get(row.osm_id) === row) this.byOsm.delete(row.osm_id);
    this.cells.get(cellOf(row).join(':'))?.delete(row);
  }

  find(c: HospitalCandidate): HospitalRow | null {
    const byId = (c.googlePlaceId && this.byGoogle.get(c.googlePlaceId)) || (c.osmId && this.byOsm.get(c.osmId));
    if (byId) return byId;
    const [lat, lng] = cellOf(c);
    let best: HospitalRow | null = null;
    for (let dLat = -1; dLat <= 1; dLat++) {
      for (let dLng = -1; dLng <= 1; dLng++) {
        for (const row of this.cells.get(`${lat + dLat}:${lng + dLng}`) ?? []) {
          if (isSameHospital(row, c) && (!best || haversineKm(row, c) < haversineKm(best, c))) best = row;
        }
      }
    }
    return best;
  }
}

type HospitalFields = Omit<HospitalRow, 'id' | 'updated_at'>;

/**
 * Combines a stored hospital with a new sighting. Google Maps wins for name, position, category and
 * rating (it is what users see on the map); OpenStreetMap fills gaps; lists are unioned.
 */
export function mergeHospital(existing: HospitalRow | null, c: HospitalCandidate): HospitalFields {
  // A second Google listing for the same hospital (often an SEO-titled duplicate) only fills gaps.
  const otherGoogleListing =
    !!existing?.google_place_id && !!c.googlePlaceId && existing.google_place_id !== c.googlePlaceId;
  const preferNew = !existing || (c.source === 'google_maps' && !otherGoogleListing);
  const address = pickAddress(existing?.address, c.address);
  return {
    name: preferNew ? c.name : otherGoogleListing && c.name.length < existing.name.length ? c.name : existing.name,
    address,
    pincode: extractPincode(address) ?? c.pincode ?? existing?.pincode ?? null,
    phones: uniq(preferNew ? [...c.phones, ...(existing?.phones ?? [])] : [...existing.phones, ...c.phones]),
    website: (preferNew ? (c.website ?? existing?.website) : (existing.website ?? c.website)) ?? null,
    category: (preferNew ? (c.category ?? existing?.category) : (existing.category ?? c.category)) ?? null,
    specialties: uniq([...(existing?.specialties ?? []), ...c.specialties]),
    open_24_hours: c.open24h ?? existing?.open_24_hours ?? null,
    emergency: c.emergency ?? existing?.emergency ?? null,
    rating: c.rating ?? existing?.rating ?? null,
    review_count: c.reviewCount ?? existing?.review_count ?? null,
    lat: preferNew ? c.lat : existing.lat,
    lng: preferNew ? c.lng : existing.lng,
    osm_id: existing?.osm_id ?? c.osmId ?? null,
    google_place_id: existing?.google_place_id ?? c.googlePlaceId ?? null,
    google_url: (preferNew ? (c.googleUrl ?? existing?.google_url) : (existing.google_url ?? c.googleUrl)) ?? null,
    sources: uniq([...(existing?.sources ?? []), ...(c.osmId ? ['osm'] : []), c.source]),
    google_details_at: c.googleDetailed ? new Date() : (existing?.google_details_at ?? null),
    google_checked_at: c.googleDetailed ? new Date() : (existing?.google_checked_at ?? null),
  };
}

const FIELD_NAMES: (keyof HospitalFields)[] = [
  'name', 'address', 'pincode', 'phones', 'website', 'category', 'specialties', 'open_24_hours', 'emergency',
  'rating', 'review_count', 'lat', 'lng', 'osm_id', 'google_place_id', 'google_url', 'sources', 'google_details_at',
  'google_checked_at',
];

type Queryable = Pick<typeof pool, 'query'>;

async function updateRow(db: Queryable, id: string, fields: HospitalFields): Promise<void> {
  const sets = FIELD_NAMES.map((f, i) => `${f} = $${i + 2}`).join(', ');
  await db.query(`UPDATE hospitals SET ${sets}, updated_at = now() WHERE id = $1`, [
    id,
    ...FIELD_NAMES.map((f) => fields[f]),
  ]);
}

/**
 * Saves a batch of sightings: each one is merged into the stored hospital it duplicates (or into an
 * earlier sighting in the same batch), otherwise inserted. One read and at most two writes in total.
 */
export async function upsertHospitals(candidates: HospitalCandidate[]): Promise<void> {
  if (candidates.length === 0) return;
  const pad = 0.003; // ~300 m, beyond the farthest distance two sightings are merged at
  const lats = candidates.map((c) => c.lat);
  const lngs = candidates.map((c) => c.lng);
  const { rows } = await pool.query<HospitalRow>(
    `SELECT ${COLUMNS} FROM hospitals
     WHERE (lat BETWEEN $1 AND $2 AND lng BETWEEN $3 AND $4)
        OR google_place_id = ANY($5) OR osm_id = ANY($6)`,
    [
      Math.min(...lats) - pad,
      Math.max(...lats) + pad,
      Math.min(...lngs) - pad,
      Math.max(...lngs) + pad,
      candidates.map((c) => c.googlePlaceId).filter(Boolean),
      candidates.map((c) => c.osmId).filter(Boolean),
    ],
  );

  const index = new HospitalIndex(rows);
  const changed = new Map<string, HospitalRow>();
  const inserted = new Set<string>();
  candidates.forEach((c, i) => {
    const existing = index.find(c);
    const row: HospitalRow = { ...mergeHospital(existing, c), id: existing?.id ?? `new:${i}`, updated_at: new Date() };
    if (existing) index.remove(existing);
    else inserted.add(row.id);
    index.add(row);
    changed.set(row.id, row);
  });

  const toJson = (rowsToWrite: HospitalRow[], withId: boolean) =>
    JSON.stringify(
      rowsToWrite.map((r) =>
        Object.fromEntries([...(withId ? [['id', r.id]] : []), ...FIELD_NAMES.map((f) => [f, r[f]])]),
      ),
    );
  const fieldList = FIELD_NAMES.join(', ');
  const newRows = [...changed.values()].filter((r) => inserted.has(r.id));
  const updatedRows = [...changed.values()].filter((r) => !inserted.has(r.id));
  if (newRows.length > 0) {
    // DO NOTHING: another request inserted the same place a moment ago; its copy is kept.
    await pool.query(
      `INSERT INTO hospitals (${fieldList})
       SELECT ${fieldList} FROM json_populate_recordset(NULL::hospitals, $1::json)
       ON CONFLICT DO NOTHING`,
      [toJson(newRows, false)],
    );
  }
  if (updatedRows.length > 0) {
    await pool.query(
      `UPDATE hospitals h SET ${FIELD_NAMES.map((f) => `${f} = r.${f}`).join(', ')}, updated_at = now()
       FROM json_populate_recordset(NULL::hospitals, $1::json) r
       WHERE h.id = r.id`,
      [toJson(updatedRows, true)],
    );
  }
}

/** Saves one sighting (see upsertHospitals). */
export function upsertHospital(c: HospitalCandidate): Promise<void> {
  return upsertHospitals([c]);
}

function rowToCandidate(row: HospitalRow): HospitalCandidate {
  return {
    source: 'osm',
    name: row.name,
    lat: row.lat,
    lng: row.lng,
    address: row.address,
    pincode: row.pincode,
    phones: row.phones,
    website: row.website,
    category: row.category,
    specialties: row.specialties,
    open24h: row.open_24_hours,
    emergency: row.emergency,
    rating: row.rating,
    reviewCount: row.review_count,
    osmId: row.osm_id,
  };
}

/**
 * Attaches a Google Maps place found by name lookup to an OpenStreetMap hospital. If that place is
 * already stored as its own hospital, the two rows are folded into one.
 */
export async function linkGooglePlace(osmRow: HospitalRow, google: HospitalCandidate): Promise<void> {
  const { rows } = await pool.query<HospitalRow>(`SELECT ${COLUMNS} FROM hospitals WHERE google_place_id = $1`, [
    google.googlePlaceId,
  ]);
  const googleRow = rows[0];
  if (!googleRow || googleRow.id === osmRow.id) {
    await updateRow(pool, osmRow.id, mergeHospital(osmRow, google));
    return;
  }
  const withOsm = mergeHospital(googleRow, rowToCandidate(osmRow));
  const fields = mergeHospital({ ...googleRow, ...withOsm }, google);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM hospitals WHERE id = $1', [osmRow.id]);
    await updateRow(client, googleRow.id, fields);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
