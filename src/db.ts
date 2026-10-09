import { Pool } from 'pg';
import { config } from './config';

export const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });

const MIGRATION = `
CREATE OR REPLACE FUNCTION haversine_km(lat1 double precision, lng1 double precision,
                                        lat2 double precision, lng2 double precision)
RETURNS double precision LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT 2 * 6371.0088 * asin(least(1, sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2))))
$$;

CREATE TABLE IF NOT EXISTS hospitals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  address           text,
  pincode           text,
  phones            text[] NOT NULL DEFAULT '{}',
  website           text,
  category          text,
  specialties       text[] NOT NULL DEFAULT '{}',
  open_24_hours     boolean,
  emergency         boolean,
  rating            real,
  review_count      integer,
  lat               double precision NOT NULL,
  lng               double precision NOT NULL,
  osm_id            text UNIQUE,
  google_place_id   text UNIQUE,
  sources           text[] NOT NULL DEFAULT '{}',
  google_url        text,
  google_details_at timestamptz,
  google_checked_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hospitals_lat_lng_idx ON hospitals (lat, lng);
ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS google_url text;
ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS google_checked_at timestamptz;

-- Circles that have already been searched for a source, so repeat requests skip scraping.
CREATE TABLE IF NOT EXISTS covered_areas (
  id         bigserial PRIMARY KEY,
  source     text NOT NULL,
  lat        double precision NOT NULL,
  lng        double precision NOT NULL,
  radius_km  double precision NOT NULL,
  scraped_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS covered_areas_source_idx ON covered_areas (source, scraped_at);

CREATE TABLE IF NOT EXISTS geocode_cache (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;

export async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    // Serializes migrations if several instances boot at once.
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(MIGRATION);
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    client.release();
  }
}
