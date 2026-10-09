# Nearby Hospitals API (India)

Give it the user's location (coordinates or a pincode) and get back the **5 nearest hospitals**, sorted by
distance, with name, address, pincode, phone numbers, website, category and rating.

Data comes from **OpenStreetMap** (all ~55k hospitals in India, kept in Postgres) and **Google Maps**,
scraped with headless Chromium (Playwright). A first request for an area takes ~5–10 s; repeat requests
are answered from the database in a few milliseconds.

## API

**Full documentation for API users is served by the API itself at [`/docs`](https://hospital-api-production-2fe9.up.railway.app/docs)**
(getting started, authentication, parameters, response fields, errors, rate limits, code examples, and a
"try it" console). The raw OpenAPI 3 spec is at `/openapi.json`.

```bash
curl "https://hospital-api-production-2fe9.up.railway.app/api/v1/hospitals/nearby?lat=12.9716&lng=77.5946" \
  -H "X-API-Key: YOUR_API_KEY"
```

| Endpoint | Auth | |
| --- | --- | --- |
| `GET /api/v1/hospitals/nearby` | API key | `lat`+`lng` or `pincode`; optional `radius_km` (1–20), `limit` (1–10) |
| `GET /health` | none | `{"status":"ok"}` |
| `GET /docs`, `GET /openapi.json` | none | Documentation |
| `POST/GET/DELETE /admin/keys` | admin key | Manage API keys (below) |

## API keys (for the API owner)

Every `/api/v1` request needs an API key in the `X-API-Key` header (or `Authorization: Bearer <key>`).
Keys are managed with the admin endpoints, which need the `ADMIN_API_KEY` secret in an `X-Admin-Key`
header. On Railway, `ADMIN_API_KEY` is in the **Hospital-api** service's **Variables** tab.

```bash
BASE=https://hospital-api-production-2fe9.up.railway.app
ADMIN=...   # the ADMIN_API_KEY value

# Create a key for a client. The full key is in the response only this once; send it to the client.
curl -X POST $BASE/admin/keys -H "X-Admin-Key: $ADMIN" -H "Content-Type: application/json" \
  -d '{"name": "Acme mobile app"}'

# List keys with usage (request_count, last_used_at). Only the first characters (key_prefix) are shown.
curl $BASE/admin/keys -H "X-Admin-Key: $ADMIN"

# Revoke a key (by its id from the list). It stops working within a minute.
curl -X DELETE $BASE/admin/keys/<id> -H "X-Admin-Key: $ADMIN"
```

- Keys are stored only as SHA-256 hashes; a lost key can't be recovered, so create a new one and revoke
  the old.
- Each key gets its own rate limit (`RATE_LIMIT_PER_MINUTE`, default 60/min) on the hospitals endpoint.
- Without `ADMIN_API_KEY` set, the admin endpoints don't exist. `REQUIRE_API_KEY=false` turns key checks
  off (e.g. for local development).

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
REQUIRE_API_KEY=false npm run dev   # API on :3000 (docs at /docs); imports India's OSM hospitals (~2 min)
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
| `MAX_BROWSER_TABS` | `6` | Chromium tabs shared by all requests (~400 MB each while open; idle tabs close after 60 s) |
| `GOOGLE_BLOCK_COOLDOWN_MIN` | `30` | Pause Google Maps after a captcha |
| `PROXY_URL` | — | e.g. `http://user:pass@host:port` for Chromium |
| `HTTP_USER_AGENT` | `nearby-hospitals-api/1.0` | Nominatim asks for an identifying UA with contact info |
| `RATE_LIMIT_PER_MINUTE` | `60` | Per API key, on the hospitals endpoint |
| `ADMIN_API_KEY` | — | Secret for the `/admin/keys` endpoints; they're off when unset |
| `REQUIRE_API_KEY` | `true` | `false` lets `/api/v1` requests through without a key |
| `PUBLIC_URL` | Railway's domain | Base URL shown in the docs' examples |

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
