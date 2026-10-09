import { migrate, pool } from './db';
import { fetchAllIndiaHospitals } from './sources/overpass';
import { isAreaCovered, markAreaCovered, upsertHospitals } from './store';
import type { HospitalCandidate } from './types';

type Logger = { info: (obj: object, msg?: string) => void; warn: (obj: object, msg?: string) => void };

// A circle this big around India's center covers the whole country, so once the import is recorded
// as a covered area, every request's OpenStreetMap step is answered from the database.
const INDIA_CENTER = { lat: 22, lng: 79 };
const INDIA_COVER_KM = 3000;

// Hospitals are saved grouped by ~50 km cells, so each batch's duplicate check only reads its area.
const GROUP_DEG = 0.5;

let running: Promise<void> | null = null;

/** Downloads every OpenStreetMap hospital in India into the database (about 1-2 minutes). */
export function importIndiaHospitals(log: Logger): Promise<void> {
  if (running) return running;
  running = (async () => {
    const started = Date.now();
    log.info({}, 'Importing all OpenStreetMap hospitals in India');
    const candidates = await fetchAllIndiaHospitals();

    const groups = new Map<string, HospitalCandidate[]>();
    for (const c of candidates) {
      const key = `${Math.floor(c.lat / GROUP_DEG)}:${Math.floor(c.lng / GROUP_DEG)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(c);
    }
    for (const group of groups.values()) await upsertHospitals(group);

    await markAreaCovered('osm', INDIA_CENTER, INDIA_COVER_KM);
    log.info({ hospitals: candidates.length, ms: Date.now() - started }, 'OpenStreetMap India import finished');
  })().finally(() => {
    running = null;
  });
  return running;
}

/** Imports at startup if the data is missing or older than CACHE_TTL_DAYS, then re-checks every 6 hours. */
export function scheduleIndiaImport(log: Logger): void {
  const check = async () => {
    try {
      if (!(await isAreaCovered('osm', INDIA_CENTER, INDIA_COVER_KM))) await importIndiaHospitals(log);
    } catch (err) {
      log.warn({ err }, 'OpenStreetMap India import failed; will retry later');
    }
  };
  void check();
  setInterval(check, 6 * 60 * 60 * 1000).unref();
}

if (require.main === module) {
  // `npm run import:osm`: one-off import, e.g. to seed a fresh database.
  const log = { info: (o: object, m?: string) => console.log(m, o), warn: (o: object, m?: string) => console.warn(m, o) };
  migrate()
    .then(() => importIndiaHospitals(log))
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
