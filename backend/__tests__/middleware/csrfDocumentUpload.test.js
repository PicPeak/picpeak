/**
 * The CSRF gate in front of the customer document upload (#1444, plan slice 11).
 *
 * The portal upload is a cookie-authenticated `multipart/form-data` POST —
 * exactly the shape a cross-site page can send from a plain HTML form with no
 * preflight, and therefore exactly what the gate exists for. The document
 * suite builds its apps with `buildRouteApp`, which does not mount CSRF, so
 * the gate was never exercised on this route.
 */
const express = require('express');
const request = require('supertest');

jest.mock('../../src/utils/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }));

const UPLOAD_PATH = '/api/customer/documents';

function buildApp() {
  const app = express();
  // The order server.js uses: parsers, then the gate on /api.
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', require('../../src/middleware/csrf'));
  // Stands in for the real route: whether the request reaches a handler at
  // all is what this is about.
  app.post(UPLOAD_PATH, (req, res) => res.status(201).json({ reached: true }));
  return app;
}

const upload = (app) => request(app).post(UPLOAD_PATH)
  .attach('file', Buffer.from('%PDF-1.4\n%%EOF\n'), { filename: 'x.pdf', contentType: 'application/pdf' });

describe('CSRF gate on the customer document upload', () => {
  it('refuses a cross-site multipart upload before it reaches the route', async () => {
    const res = await upload(buildApp().use((_req, _res, next) => next()))
      .set('sec-fetch-site', 'cross-site');
    expect(res.status).toBe(403);
    expect(res.body.reached).toBeUndefined();
  });

  it('refuses one that carries a foreign Origin', async () => {
    const res = await upload(buildApp()).set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
  });

  it('lets the portal\'s own upload through', async () => {
    const res = await upload(buildApp()).set('sec-fetch-site', 'same-origin');
    expect(res.status).toBe(201);
    expect(res.body.reached).toBe(true);
  });
});
