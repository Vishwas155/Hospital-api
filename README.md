# Nearby Hospitals API (India)

Give it the user's location (coordinates or a pincode) and get back the **5 nearest hospitals**, sorted by
distance, with name, address, pincode, phone numbers, website, category and rating.

Data comes from **OpenStreetMap** (all ~55k hospitals in India, kept in Postgres) and **Google Maps**,
scraped with headless Chromium (Playwright). A first request for an area takes ~5–10 s; repeat requests
are answered from the database in a few milliseconds.

## API

### `GET /api/v1/hospitals/nearby`

| Param | Required | Notes |
| --- | --- | --- |
| `lat`, `lng` | one of these or `pincode` | Must be inside India |
| `pincode` | | 6-digit Indian PIN code; used as the location when no coordinates are given |
| `radius_km` | no | Default `20`, allowed `1`–`20` (`MIN_RADIUS_KM`/`MAX_RADIUS_KM`); anything else is a `400` |
| `limit` | no | Default `5`, max `10` |

```bash
curl "http://localhost:3000/api/v1/hospitals/nearby?lat=12.9716&lng=77.5946"
curl "http://localhost:3000/api/v1/hospitals/nearby?pincode=570001&radius_km=10"
```

```jsonc
{
  "query": { "lat": 12.3141, "lng": 76.6441, "pincode": "570001", "radius_km": 20, "resolved_from": "pincode" },
  "within_radius": true,           // false => nothing inside the radius; these are the nearest outside it
  "message": "...",                // present when within_radius is false
  "warnings": ["..."],             // e.g. some details were still loading (repeat the request shortly)
  "took_ms": 7956,
  "count": 5,
  "hospitals": [{
    "id": "uuid",
    "name": "Krishna Rajendra Hospital",
    "distance_km": 0.71,
    "address": "KR Hospital, Irwin Rd, Devaraja Mohalla, Yadavagiri, Mysuru, Karnataka 570001",
    "pincode": "570001",
    "phones": ["+918212526200"],
    "website": "https://...",
    "category": "Government hospital",
    "specialties": [],
    "open_24_hours": true,
    "emergency": null,
    "rating": 4.0,
    "review_count": 1520,
    "lat": 12.3140, "lng": 76.6507,
    "google_maps_url": "https://www.google.com/maps/place/?q=place_id:...",
    "sources": ["osm", "google_maps"],
    "last_updated_at": "2026-10-09T06:00:43.072Z"
  }]
}
```

### `GET /health`

## How a request works

1. **Location**: the given coordinates, or the pincode geocoded with Nominatim (falls back to India
   Post's post-office list for pincodes OpenStreetMap doesn't know).
2. **In parallel** (~3 s):
   - **OpenStreetMap**: a database lookup. All of India's OSM hospitals are imported at startup and
     refreshed weekly, so requests never wait on the public Overpass servers. (Until the first import
     finishes, the area is fetched live, waiting at most `OSM_WAIT_MS`.)
   - **Google Maps**: one "hospitals" search around the user; every hospital in the result list is
     saved. If it finds nothing inside the radius, it also searches "hospitals in &lt;user's pincode&gt;".
3. **Nearest 5**: sightings within ~150 m with matching names (typos tolerated) or a shared phone number
   are merged into one hospital, then the 5 nearest are taken.
4. **Details for those 5 only** (in parallel, ~3–5 s): each one's Google Maps place page is opened for the
   full address, every phone number and the website. Hospitals only OpenStreetMap knows are looked up on
   Google Maps by name first.
5. **Nothing in the radius?** The 5 nearest hospitals outside it are returned (up to 100 km away) with
   `within_radius: false`.

Each request waits at most `REQUEST_BUDGET_MS` (15 s). Anything still running then finishes in the
background and is saved, so repeating the request returns complete data. Google Maps details are reused
for `CACHE_TTL_DAYS` (7).

## Running locally

```bash
npm install
npx playwright install chromium
npm run db:dev        # embedded Postgres on :5433 (no Docker needed); keep it running
npm run dev           # API on :3000; imports India's OSM hospitals in the background (~2 min)
npm test              # unit tests
```

`npm run import:osm` (after `npm run build`) runs the OpenStreetMap import on its own, e.g. to seed a new
database before the first deploy.

## Deploying to Railway

The repo has a `Dockerfile` (built on Playwright's image, so Chromium is included) and `railway.json`
(health check on `/health`).

1. Create a project with a **Postgres** database and a service from this folder.
2. Set `DATABASE_URL=${{Postgres.DATABASE_URL}}` on the service.
3. Give the service **at least 2 GB RAM** (Chromium) and pick the **Asia (Singapore)** region: Google
   returns India-relevant results and skips the EU cookie-consent page.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `DATABASE_URL` | local dev DB | Postgres connection string |
| `PORT` | `3000` | |
| `DEFAULT_RADIUS_KM` / `MIN_RADIUS_KM` / `MAX_RADIUS_KM` | `20` / `1` / `20` | Radius rules |
| `DEFAULT_LIMIT` / `MAX_LIMIT` | `5` / `10` | Hospitals per response |
| `NEAREST_FALLBACK_MAX_KM` | `100` | How far to look when nothing is inside the radius |
| `REQUEST_BUDGET_MS` | `15000` | Longest a request waits on OpenStreetMap / Google Maps |
| `OSM_WAIT_MS` | `5000` | Longest a request waits on a live OpenStreetMap fetch (before the import exists) |
| `CACHE_TTL_DAYS` | `7` | How long scraped data and the OSM import are reused |
| `OSM_IMPORT_ENABLED` | `true` | Keep all of India's OSM hospitals in the database |
| `GOOGLE_MAPS_ENABLED` | `true` | `false` = OpenStreetMap only |
| `MAX_BROWSER_TABS` | `6` | Chromium tabs shared by all requests (~150 MB each) |
| `GOOGLE_BLOCK_COOLDOWN_MIN` | `30` | Pause Google Maps after a captcha |
| `PROXY_URL` | — | e.g. `http://user:pass@host:port` for Chromium |
| `HTTP_USER_AGENT` | `nearby-hospitals-api/1.0` | Nominatim asks for an identifying UA with contact info |
| `RATE_LIMIT_PER_MINUTE` | `60` | Per client IP |

## Known limitations

- **Google Maps scraping is against Google's Terms of Service** and can be blocked (captcha). The API
  then serves OpenStreetMap data only and retries Google after the cooldown. For production volume, use
  a residential `PROXY_URL` or replace `src/sources/googleMaps.ts` with the Google Places API.
- **Concurrent first-time requests share the browser tabs.** Four new areas at once need ~24 Google
  pages between them, so with 6 tabs they hit the 15 s limit and return partly filled details (the rest
  is saved moments later). Raise `MAX_BROWSER_TABS` together with RAM if that matters.
- Google's selectors (top of `src/sources/googleMaps.ts`) change occasionally; if Google data stops
  appearing, check those first.
- Not every hospital has a phone number on Google Maps or OpenStreetMap; expect about 3–4 of 5 to have one.
- Some Google listings sit at an approximate point (Google's own data), so their `distance_km` can be off.
- Specialties come from OpenStreetMap tags only and are often empty.
- `distance_km` is straight-line distance, not driving distance.
