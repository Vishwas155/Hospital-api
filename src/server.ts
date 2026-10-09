import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createApiKey, isAdminKey, listApiKeys, recordApiKeyUse, revokeApiKey, verifyApiKey } from './apiKeys';
import { config } from './config';
import { pool } from './db';
import { openApiDocument } from './openapi';
import { isInIndia } from './geo';
import { NotFoundError, searchHospitals } from './search';

const nearbyQuery = z
  .object({
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    pincode: z
      .string()
      .trim()
      .regex(/^[1-9]\d{5}$/, 'pincode must be a 6-digit Indian PIN code')
      .optional(),
    radius_km: z.coerce.number().optional(),
    limit: z.coerce.number().int().min(1).max(config.maxLimit).default(config.defaultLimit),
  })
  .superRefine((q, ctx) => {
    if ((q.lat === undefined) !== (q.lng === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'lat and lng must be provided together', path: ['lat'] });
    }
    if (q.lat === undefined && q.pincode === undefined) {
      ctx.addIssue({ code: 'custom', message: 'Provide lat and lng, or a pincode', path: ['lat'] });
    }
    if (q.lat !== undefined && q.lng !== undefined && !isInIndia(q.lat, q.lng)) {
      ctx.addIssue({ code: 'custom', message: 'Coordinates are outside India; this API only covers India', path: ['lat'] });
    }
    if (q.radius_km !== undefined && (q.radius_km < config.minRadiusKm || q.radius_km > config.maxRadiusKm)) {
      ctx.addIssue({
        code: 'custom',
        message: `radius_km must be between ${config.minRadiusKm} and ${config.maxRadiusKm} km`,
        path: ['radius_km'],
      });
    }
  });

declare module 'fastify' {
  interface FastifyRequest {
    apiKeyId: string | null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function presentedApiKey(req: FastifyRequest): string | undefined {
  const header = req.headers['x-api-key'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  const auth = req.headers.authorization;
  return auth?.match(/^Bearer\s+(\S+)$/i)?.[1];
}

async function requireApiKey(req: FastifyRequest, reply: FastifyReply) {
  const key = presentedApiKey(req);
  if (!key) {
    return reply
      .status(401)
      .send({ error: 'unauthorized', message: 'Missing API key. Send it in the X-API-Key header.' });
  }
  const keyId = await verifyApiKey(key);
  if (!keyId) return reply.status(401).send({ error: 'unauthorized', message: 'Invalid or revoked API key.' });
  req.apiKeyId = keyId;
  recordApiKeyUse(keyId);
}

const ERROR_CODES: Record<number, string> = { 400: 'bad_request', 401: 'unauthorized', 404: 'not_found', 429: 'rate_limited' };

export async function buildServer() {
  const app = Fastify({ logger: { level: config.logLevel }, trustProxy: true });
  app.decorateRequest('apiKeyId', null);

  // Authenticate first (onRequest) so the rate limit (preHandler) can count per key. Only the
  // hospitals endpoint is rate limited; docs, health and admin calls aren't.
  app.addHook('onRequest', async (req, reply) => {
    if (config.requireApiKey && req.url.startsWith('/api/')) return requireApiKey(req, reply);
  });
  await app.register(rateLimit, {
    global: false,
    max: config.rateLimitPerMinute,
    timeWindow: '1 minute',
    hook: 'preHandler',
    keyGenerator: (req) => req.apiKeyId ?? req.ip,
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: 429,
      error: 'rate_limited',
      message: `Rate limit exceeded: ${ctx.max} requests per ${ctx.after}. Try again later.`,
    }),
  });

  app.setErrorHandler((err: Error & { statusCode?: number; error?: string }, req, reply) => {
    if (err.statusCode && err.statusCode < 500) {
      return reply
        .status(err.statusCode)
        .send({ error: err.error ?? ERROR_CODES[err.statusCode] ?? 'bad_request', message: err.message });
    }
    req.log.error({ err }, 'Unhandled error');
    return reply.status(500).send({ error: 'internal_error', message: 'Something went wrong' });
  });

  // Public documentation: interactive at /docs, raw spec at /openapi.json
  await app.register(swagger, { mode: 'static', specification: { document: openApiDocument() as never } });
  await app.register(swaggerUi, {
    routePrefix: '/docs',
    theme: { title: 'Nearby Hospitals API · Docs' },
    uiConfig: {
      layout: 'BaseLayout', // no top bar with its spec-URL box
      docExpansion: 'list',
      deepLinking: true,
      persistAuthorization: true,
      tryItOutEnabled: true,
    },
  });
  app.get('/openapi.json', async () => app.swagger());
  app.get('/', async (_req, reply) => reply.redirect('/docs'));

  // Key management for the API owner, protected by ADMIN_API_KEY (off when it isn't set)
  if (config.adminApiKey) {
    await app.register(
      async (admin) => {
        admin.addHook('onRequest', async (req, reply) => {
          const header = req.headers['x-admin-key'];
          if (!isAdminKey(typeof header === 'string' ? header : undefined)) {
            return reply.status(401).send({ error: 'unauthorized', message: 'Missing or wrong X-Admin-Key header.' });
          }
        });
        admin.post('/keys', async (req, reply) => {
          const body = z.object({ name: z.string().trim().min(1).max(100) }).safeParse(req.body ?? {});
          if (!body.success) {
            return reply.status(400).send({ error: 'validation_error', message: 'Body must be JSON: {"name": "..."}' });
          }
          const { key, row } = await createApiKey(body.data.name);
          return reply.status(201).send({ ...row, key, note: 'Store this key now; it cannot be shown again.' });
        });
        admin.get('/keys', async () => ({ keys: await listApiKeys() }));
        admin.delete<{ Params: { id: string } }>('/keys/:id', async (req, reply) => {
          const row = UUID.test(req.params.id) ? await revokeApiKey(req.params.id) : null;
          if (!row) return reply.status(404).send({ error: 'not_found', message: 'No such key' });
          return row;
        });
      },
      { prefix: '/admin' },
    );
  }

  app.get('/health', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ok' };
    } catch {
      return reply.status(503).send({ status: 'database_unavailable' });
    }
  });

  app.get('/api/v1/hospitals/nearby', { config: { rateLimit: {} } }, async (req, reply) => {
    const parsed = nearbyQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'validation_error',
        message: parsed.error.issues.map((i) => i.message).join('; '),
        details: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      });
    }
    const q = parsed.data;
    try {
      return await searchHospitals(
        {
          lat: q.lat,
          lng: q.lng,
          pincode: q.pincode,
          radiusKm: q.radius_km ?? config.defaultRadiusKm,
          limit: q.limit,
        },
        req.log,
      );
    } catch (err) {
      if (err instanceof NotFoundError) return reply.status(404).send({ error: 'not_found', message: err.message });
      throw err;
    }
  });

  return app;
}
