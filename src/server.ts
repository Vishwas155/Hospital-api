import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { z } from 'zod';
import { config } from './config';
import { pool } from './db';
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

export async function buildServer() {
  const app = Fastify({ logger: { level: config.logLevel }, trustProxy: true });
  await app.register(rateLimit, { max: config.rateLimitPerMinute, timeWindow: '1 minute' });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.message });
    req.log.error({ err }, 'Unhandled error');
    return reply.status(500).send({ error: 'internal_error', message: 'Something went wrong' });
  });

  app.get('/health', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ok' };
    } catch {
      return reply.status(503).send({ status: 'database_unavailable' });
    }
  });

  app.get('/api/v1/hospitals/nearby', async (req, reply) => {
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
