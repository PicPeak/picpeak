/**
 * OpenAPI 3.1 spec for /api/v1/* (#322). Source of truth for the
 * picpeak-docs reference page. Built from JSDoc `@openapi` blocks
 * scattered through src/routes/v1 — those stay co-located with the
 * routes they describe so the spec can't drift in isolation.
 */

const swaggerJSDoc = require('swagger-jsdoc');
const path = require('path');

const baseDoc = {
  openapi: '3.0.3',
  info: {
    title: 'PicPeak API',
    version: 'v1',
    description:
      'Public REST API for PicPeak — create gallery events, upload photos, fetch share links. ' +
      'Authenticate with a Bearer token issued via the admin **Settings → API Tokens** tab.'
  },
  servers: [
    { url: '/api/v1', description: 'Same-origin (production)' }
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'pp_live_*',
        description:
          'Long-lived API token. Issue via Settings → API Tokens. ' +
          'Token format: `pp_live_<random>`. Scopes: `read`, `write`, `admin`.'
      }
    },
    schemas: {
      EventSummary: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          slug: { type: 'string' },
          event_name: { type: 'string' },
          event_type: { type: 'string' },
          event_date: { type: 'string', format: 'date', nullable: true },
          expires_at: { type: 'string', format: 'date-time', nullable: true },
          is_active: { type: 'boolean' },
          is_archived: { type: 'boolean' },
          is_draft: { type: 'boolean' },
          created_at: { type: 'string', format: 'date-time' }
        }
      }
    }
  },
  security: [{ bearerAuth: [] }]
};

const options = {
  definition: baseDoc,
  // Pull @openapi blocks from every v1 route file.
  apis: [path.join(__dirname, '../routes/v1/**/*.js')]
};

let cached = null;

function getOpenApiSpec() {
  if (!cached) {
    cached = swaggerJSDoc(options);
  }
  return cached;
}

module.exports = { getOpenApiSpec };
