function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Environment variable ${name} must be a number, got "${raw}"`);
  return value;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function list(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export const config = {
  port: num('PORT', 3000),
  host: process.env.HOST ?? '0.0.0.0',
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/hospitals',

  // Radius rules
  defaultRadiusKm: num('DEFAULT_RADIUS_KM', 20),
  minRadiusKm: num('MIN_RADIUS_KM', 1),
  maxRadiusKm: num('MAX_RADIUS_KM', 20),
  // When nothing is inside the radius, the nearest hospitals are returned, searching up to this far.
  nearestFallbackMaxKm: num('NEAREST_FALLBACK_MAX_KM', 100),

  // How many hospitals a response returns (nearest first).
  defaultLimit: num('DEFAULT_LIMIT', 5),
  maxLimit: num('MAX_LIMIT', 10),

  // Data for an area, and a hospital's Google Maps details, are reused for this many days.
  cacheTtlDays: num('CACHE_TTL_DAYS', 7),

  // Google Maps scraping (headless Chromium)
  googleMapsEnabled: bool('GOOGLE_MAPS_ENABLED', true),
  // Browser tabs shared by all requests; also the number of hospitals enriched in parallel.
  maxBrowserTabs: num('MAX_BROWSER_TABS', 6),
  // Longest a request waits on outside sources (OpenStreetMap, Google Maps). Work still running
  // afterwards finishes in the background and is saved, so the next request for the area gets it.
  requestBudgetMs: num('REQUEST_BUDGET_MS', 15_000),
  // Longest a request waits for OpenStreetMap before continuing with Google Maps results alone.
  osmWaitMs: num('OSM_WAIT_MS', 5_000),
  // After a captcha, Google Maps is skipped for this long.
  googleBlockCooldownMin: num('GOOGLE_BLOCK_COOLDOWN_MIN', 30),
  proxyUrl: process.env.PROXY_URL || undefined,

  // Keep all of India's OpenStreetMap hospitals in the database (refreshed every CACHE_TTL_DAYS),
  // so requests never wait on the public Overpass servers.
  osmImportEnabled: bool('OSM_IMPORT_ENABLED', true),

  // Free OpenStreetMap services
  overpassUrls: list('OVERPASS_URLS', [
    'https://overpass-api.de/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
  ]),
  nominatimUrl: process.env.NOMINATIM_URL ?? 'https://nominatim.openstreetmap.org',
  // Nominatim's usage policy asks for an identifying User-Agent with contact details.
  httpUserAgent: process.env.HTTP_USER_AGENT ?? 'nearby-hospitals-api/1.0',

  rateLimitPerMinute: num('RATE_LIMIT_PER_MINUTE', 60),
  logLevel: process.env.LOG_LEVEL ?? 'info',
};
