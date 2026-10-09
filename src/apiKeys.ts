import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config';
import { pool } from './db';

export interface ApiKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  request_count: string;
  last_used_at: Date | null;
  created_at: Date;
  revoked_at: Date | null;
}

const PUBLIC_COLUMNS = 'id, name, key_prefix, request_count, last_used_at, created_at, revoked_at';

// Keys look like "hk_" + 32 random URL-safe characters. Only a SHA-256 hash is stored, so a
// database leak doesn't expose usable keys; the full key is shown once, when it is created.
const sha256 = (value: string) => createHash('sha256').update(value).digest();

export async function createApiKey(name: string): Promise<{ key: string; row: ApiKeyRow }> {
  const key = `hk_${randomBytes(24).toString('base64url')}`;
  const { rows } = await pool.query<ApiKeyRow>(
    `INSERT INTO api_keys (name, key_prefix, key_hash) VALUES ($1, $2, $3) RETURNING ${PUBLIC_COLUMNS}`,
    [name, key.slice(0, 7), sha256(key).toString('hex')],
  );
  return { key, row: rows[0] };
}

export async function listApiKeys(): Promise<ApiKeyRow[]> {
  const { rows } = await pool.query<ApiKeyRow>(`SELECT ${PUBLIC_COLUMNS} FROM api_keys ORDER BY created_at`);
  return rows;
}

export async function revokeApiKey(id: string): Promise<ApiKeyRow | null> {
  const { rows } = await pool.query<ApiKeyRow>(
    `UPDATE api_keys SET revoked_at = coalesce(revoked_at, now()) WHERE id = $1 RETURNING ${PUBLIC_COLUMNS}`,
    [id],
  );
  verified.clear();
  return rows[0] ?? null;
}

// Lookups are cached for a minute so a busy client doesn't cost a database query per request.
const verified = new Map<string, { keyId: string | null; expires: number }>();

/** The key's id if it exists and isn't revoked, otherwise null. */
export async function verifyApiKey(key: string): Promise<string | null> {
  const hash = sha256(key).toString('hex');
  const hit = verified.get(hash);
  if (hit && hit.expires > Date.now()) return hit.keyId;
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL',
    [hash],
  );
  if (verified.size > 10_000) verified.clear(); // bound memory if someone sprays random keys
  const keyId = rows[0]?.id ?? null;
  verified.set(hash, { keyId, expires: Date.now() + 60_000 });
  return keyId;
}

export function recordApiKeyUse(keyId: string): void {
  pool
    .query('UPDATE api_keys SET request_count = request_count + 1, last_used_at = now() WHERE id = $1', [keyId])
    .catch(() => {});
}

/** Constant-time check of the X-Admin-Key header against ADMIN_API_KEY. */
export function isAdminKey(provided: string | undefined): boolean {
  if (!config.adminApiKey || !provided) return false;
  return timingSafeEqual(sha256(provided), sha256(config.adminApiKey));
}
