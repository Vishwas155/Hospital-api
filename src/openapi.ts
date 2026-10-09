import { config } from './config';

// The public API reference, served at /docs (interactive) and /openapi.json.
// Keep it in step with src/server.ts and src/search.ts when the API changes.

const guide = (baseUrl: string) => `
Find the **nearest hospitals** to any location in India, with name, distance, address, phone numbers,
website and Google Maps link, in a single request.

## Quick start

1. **Get an API key** from the API owner. It looks like \`hk_...\`.
2. **Send it** in the \`X-API-Key\` header with every request:

\`\`\`bash
curl "${baseUrl}/api/v1/hospitals/nearby?lat=12.9716&lng=77.5946" \\
  -H "X-API-Key: YOUR_API_KEY"
\`\`\`

You get back the 5 nearest hospitals, closest first. To try it here, click **Authorize**, paste your key,
then open the endpoint below and click **Try it out**.

## Authentication

Every \`/api/v1\` request needs a key, sent either way:

| Header | Example |
|---|---|
| \`X-API-Key\` | \`X-API-Key: hk_2f9...\` |
| \`Authorization\` | \`Authorization: Bearer hk_2f9...\` |

A missing, wrong or revoked key gets **401 Unauthorized**. Keep your key on your server; don't ship it in
a mobile app or web page where users can read it.

## Choosing the location

Send **either** coordinates **or** a pincode:

- \`lat\` + \`lng\`: the user's position, e.g. from the phone's GPS. Must be inside India.
- \`pincode\`: a 6-digit Indian PIN code, used when you don't have coordinates. Distances are then measured
  from the pincode's center (shown in \`query.lat\`/\`query.lng\` in the response).

Optional:

- \`radius_km\`: how far to look, \`1\`–\`20\` km (default \`20\`).
- \`limit\`: how many hospitals to return, \`1\`–\`10\` (default \`5\`).

## Response times

| Situation | Typical time |
|---|---|
| Area searched by anyone in the last 7 days | under 0.5 s |
| First search ever for an area | 5–10 s |
| Never longer than | ~15 s |

The first search for an area gathers fresh data, so set your HTTP client's timeout to **at least 20 seconds**.
If a response has a \`warnings\` entry saying details were still loading, some phone numbers or addresses
weren't ready yet: repeat the same request a few seconds later to get them.

## When nothing is inside the radius

You still get the nearest hospitals, just farther away. Check \`within_radius\`:

- \`true\`: every hospital returned is inside \`radius_km\`.
- \`false\`: none were; these are the nearest ones outside it (up to 100 km), and \`message\` says so.

Show \`distance_km\` to your users either way.

## Rate limits

**60 requests per minute per API key.** Going over returns **429 Too Many Requests**; wait a minute and
retry. Contact the API owner if you need more.

## Errors

Errors are JSON with an \`error\` code and a human-readable \`message\`:

\`\`\`json
{ "error": "validation_error", "message": "radius_km must be between 1 and 20 km" }
\`\`\`

| Status | \`error\` | Meaning |
|---|---|---|
| 400 | \`validation_error\` | A parameter is missing or invalid (see \`message\` and \`details\`) |
| 401 | \`unauthorized\` | API key missing, wrong or revoked |
| 404 | \`not_found\` | The pincode couldn't be located |
| 429 | \`rate_limited\` | Too many requests this minute |
| 500 | \`internal_error\` | Something went wrong on our side; retry, and report it if it persists |

## Code examples

**JavaScript (Node 18+ or browser-side server code)**

\`\`\`js
const params = new URLSearchParams({ lat: '12.9716', lng: '77.5946' });
const res = await fetch(\`${baseUrl}/api/v1/hospitals/nearby?\${params}\`, {
  headers: { 'X-API-Key': process.env.HOSPITALS_API_KEY },
  signal: AbortSignal.timeout(20_000),
});
if (!res.ok) throw new Error((await res.json()).message);
const { hospitals } = await res.json();
for (const h of hospitals) console.log(h.distance_km, 'km', h.name, h.phones[0] ?? 'no phone');
\`\`\`

**Python**

\`\`\`python
import os, requests

res = requests.get(
    "${baseUrl}/api/v1/hospitals/nearby",
    params={"pincode": "560001", "radius_km": 10},
    headers={"X-API-Key": os.environ["HOSPITALS_API_KEY"]},
    timeout=20,
)
res.raise_for_status()
for h in res.json()["hospitals"]:
    print(h["distance_km"], "km", h["name"], h["phones"])
\`\`\`

## About the data

- Hospitals come from **OpenStreetMap** and **Google Maps** and are merged into one entry per hospital.
- **Phone numbers** are in international format (\`+91...\`); toll-free numbers start with \`1800\`/\`1860\`.
  Not every hospital has one listed; expect about 3–4 of every 5 to.
- **\`distance_km\`** is the straight-line distance, not driving distance.
- Data for an area is refreshed every 7 days.
- Coverage is **India only**.
`;

const hospital = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid', description: 'Stable id for this hospital' },
    name: { type: 'string', example: 'Krishna Rajendra Hospital' },
    distance_km: { type: 'number', description: 'Straight-line distance from the location', example: 0.71 },
    address: { type: 'string', nullable: true, example: 'KR Hospital, Irwin Rd, Devaraja Mohalla, Mysuru, Karnataka 570001' },
    pincode: { type: 'string', nullable: true, example: '570001' },
    phones: {
      type: 'array',
      items: { type: 'string' },
      description: 'International format; may be empty',
      example: ['+918212526200'],
    },
    website: { type: 'string', nullable: true, example: 'https://example-hospital.in' },
    category: { type: 'string', nullable: true, example: 'Government hospital' },
    specialties: { type: 'array', items: { type: 'string' }, description: 'Often empty', example: [] },
    open_24_hours: { type: 'boolean', nullable: true, description: 'true when listed as open 24 hours; null if unknown' },
    emergency: { type: 'boolean', nullable: true, description: 'Has an emergency department; null if unknown' },
    rating: { type: 'number', nullable: true, description: 'Google Maps rating, 1–5', example: 3.1 },
    review_count: { type: 'integer', nullable: true, example: 376 },
    lat: { type: 'number', example: 12.31402 },
    lng: { type: 'number', example: 76.65071 },
    google_maps_url: { type: 'string', description: 'Opens the hospital in Google Maps (directions, photos)' },
    sources: {
      type: 'array',
      items: { type: 'string', enum: ['osm', 'google_maps'] },
      description: 'Where this entry came from',
    },
    last_updated_at: { type: 'string', format: 'date-time' },
  },
};

// A real response (pincode 570001, Mysuru, 9 Oct 2026), trimmed to two hospitals.
const sampleResponse = {
  query: { lat: 12.3141403, lng: 76.644151, pincode: '570001', radius_km: 20, resolved_from: 'pincode' },
  within_radius: true,
  took_ms: 16,
  count: 2,
  hospitals: [
    {
      id: '7ea804d6-36d2-4236-b600-5c19c1542c34',
      name: 'Cheluvamba Hospital',
      distance_km: 0.56,
      address: '8J7X+JPV, Opp Mysore Medical College, KR Hospital Compound, Irwin Rd, Devraj Mohalla, Mysuru, Karnataka 570001',
      pincode: '570001',
      phones: ['+918212520512'],
      website: 'https://mmcri.karnataka.gov.in/info-1/Cheluvamba+Hospital/en',
      category: 'Government hospital',
      specialties: [],
      open_24_hours: true,
      emergency: null,
      rating: 2.8,
      review_count: 101,
      lat: 12.31412,
      lng: 76.64931,
      google_maps_url: 'https://www.google.com/maps/place/?q=place_id:ChIJJQDHL3NwrzsR0sFNV-hqSIg',
      sources: ['osm', 'google_maps'],
      last_updated_at: '2026-10-09T09:58:12.000Z',
    },
    {
      id: '56576db0-c321-400e-aebb-d2f9db494d92',
      name: 'Krishna Rajendra Hospital',
      distance_km: 0.71,
      address: 'KR Hospital, Irwin Rd, Devaraja Mohalla, Yadavagiri, Mysuru, Karnataka 570001',
      pincode: '570001',
      phones: ['+918212526200'],
      website: null,
      category: 'Government hospital',
      specialties: [],
      open_24_hours: true,
      emergency: true,
      rating: 3.1,
      review_count: 376,
      lat: 12.31402,
      lng: 76.65071,
      google_maps_url:
        'https://www.google.com/maps/place/Krishna+Rajendra+Hospital/data=!4m6!3m5!1s0x3baf700cd5376b37:0x1fb775ae37f3ae0d!8m2!3d12.3140248!4d76.6507101',
      sources: ['osm', 'google_maps'],
      last_updated_at: '2026-10-09T09:58:12.000Z',
    },
  ],
};

const error = (code: string, message: string) => ({
  description: message,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/Error' },
      example: { error: code, message },
    },
  },
});

export function openApiDocument() {
  const baseUrl = config.publicUrl.replace(/\/$/, '');
  return {
    openapi: '3.0.3',
    info: { title: 'Nearby Hospitals API (India)', version: '1.0.0', description: guide(baseUrl) },
    servers: [{ url: baseUrl }],
    tags: [{ name: 'Hospitals' }, { name: 'Status' }],
    components: {
      securitySchemes: {
        ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      },
      schemas: {
        Hospital: hospital,
        Error: {
          type: 'object',
          required: ['error', 'message'],
          properties: {
            error: { type: 'string' },
            message: { type: 'string' },
            details: {
              type: 'array',
              items: { type: 'object', properties: { field: { type: 'string' }, message: { type: 'string' } } },
            },
          },
        },
      },
    },
    paths: {
      '/api/v1/hospitals/nearby': {
        get: {
          tags: ['Hospitals'],
          summary: 'Nearest hospitals to a location',
          description:
            'Returns the nearest hospitals to the given coordinates or pincode, closest first. ' +
            'Send `lat` + `lng`, or `pincode`.',
          security: [{ ApiKeyAuth: [] }],
          parameters: [
            { name: 'lat', in: 'query', schema: { type: 'number', minimum: -90, maximum: 90 }, description: 'Latitude (with `lng`)', example: 12.9716 },
            { name: 'lng', in: 'query', schema: { type: 'number', minimum: -180, maximum: 180 }, description: 'Longitude (with `lat`)', example: 77.5946 },
            { name: 'pincode', in: 'query', schema: { type: 'string', pattern: '^[1-9][0-9]{5}$' }, description: '6-digit Indian PIN code, instead of `lat`/`lng`' },
            { name: 'radius_km', in: 'query', schema: { type: 'number', minimum: config.minRadiusKm, maximum: config.maxRadiusKm, default: config.defaultRadiusKm }, description: 'Search radius in km' },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: config.maxLimit, default: config.defaultLimit }, description: 'How many hospitals to return' },
          ],
          responses: {
            200: {
              description: 'The nearest hospitals',
              content: {
                'application/json': {
                  example: sampleResponse,
                  schema: {
                    type: 'object',
                    properties: {
                      query: {
                        type: 'object',
                        description: 'The location used (for a pincode, its center)',
                        properties: {
                          lat: { type: 'number' },
                          lng: { type: 'number' },
                          pincode: { type: 'string', nullable: true },
                          radius_km: { type: 'number' },
                          resolved_from: { type: 'string', enum: ['coordinates', 'pincode'] },
                        },
                      },
                      within_radius: {
                        type: 'boolean',
                        description: 'false when nothing was inside the radius and these are the nearest outside it',
                      },
                      message: { type: 'string', description: 'Present when within_radius is false' },
                      warnings: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Present when some data was still loading or a source was unavailable',
                      },
                      took_ms: { type: 'integer', description: 'Server processing time' },
                      count: { type: 'integer' },
                      hospitals: { type: 'array', items: { $ref: '#/components/schemas/Hospital' } },
                    },
                  },
                },
              },
            },
            400: error('validation_error', 'radius_km must be between 1 and 20 km'),
            401: error('unauthorized', 'Missing API key. Send it in the X-API-Key header.'),
            404: error('not_found', 'Could not find a location for pincode 999999'),
            429: error('rate_limited', 'Rate limit exceeded: 60 requests per 1 minute. Try again later.'),
            500: error('internal_error', 'Something went wrong'),
          },
        },
      },
      '/health': {
        get: {
          tags: ['Status'],
          summary: 'Service health',
          description: 'No API key needed.',
          responses: {
            200: { description: 'Up', content: { 'application/json': { example: { status: 'ok' } } } },
            503: { description: 'Database unavailable', content: { 'application/json': { example: { status: 'database_unavailable' } } } },
          },
        },
      },
    },
  };
}
