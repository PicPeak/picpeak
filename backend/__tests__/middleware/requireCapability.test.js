jest.mock('../../src/database/db', () => ({ db: jest.fn() }));
jest.mock('../../src/services/dependencyHealth', () => ({ evaluate: jest.fn() }));

const express = require('express');
const request = require('supertest');
const dependencyHealth = require('../../src/services/dependencyHealth');
const { requireCapability } = require('../../src/middleware/requireCapability');

const blocked = { name: 'uploads.new', available: false, paused: true, forced: false, blockedBy: ['storage'] };

function buildApp() {
  const app = express();
  const auth = (req, res, next) => (req.headers.authorization ? next() : res.status(401).json({ error: 'Unauthorized' }));
  app.post('/upload', auth, requireCapability('uploads.new'), (req, res) => res.json({ ok: true }));
  return app;
}

beforeEach(() => {
  dependencyHealth.evaluate.mockReturnValue(blocked);
});

describe('requireCapability', () => {
  it('refuses to mount with an unknown name', () => {
    expect(() => requireCapability('uploads.nwe')).toThrow('Unknown capability');
  });

  it('passes while the capability is available', async () => {
    dependencyHealth.evaluate.mockReturnValue({ ...blocked, available: true, blockedBy: [] });
    const res = await request(buildApp()).post('/upload').set('Authorization', 'Bearer x');
    expect(res.status).toBe(200);
  });

  it('answers a retryable 503 that names no dependency', async () => {
    const res = await request(buildApp()).post('/upload').set('Authorization', 'Bearer x');
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('60');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers.connection).toBe('close');
    expect(res.body).toEqual({
      error: 'This feature is temporarily unavailable',
      code: 'CAPABILITY_UNAVAILABLE',
      capability: 'uploads.new',
    });
  });

  describe('a plain link', () => {
    const appWithDownload = () => {
      const app = express();
      app.get('/download', requireCapability('uploads.new'), (req, res) => res.json({ ok: true }));
      return app;
    };

    it('gets a short page instead of raw JSON', async () => {
      const res = await request(appWithDownload()).get('/download').set('Accept', 'text/html,application/xhtml+xml,*/*;q=0.8');
      expect(res.status).toBe(503);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.headers['retry-after']).toBe('60');
      expect(res.text).toContain('paused for a moment');
    });

    it('still answers an API client with JSON', async () => {
      const res = await request(appWithDownload()).get('/download').set('Accept', '*/*');
      expect(res.body.code).toBe('CAPABILITY_UNAVAILABLE');
    });
  });

  it('only logs an automatic pause in observe mode', async () => {
    dependencyHealth.evaluate.mockReturnValue({ ...blocked, paused: false });
    const res = await request(buildApp()).post('/upload').set('Authorization', 'Bearer x');
    expect(res.status).toBe(200);
  });

  it('never lets an anonymous caller past or tells them the state', async () => {
    const res = await request(buildApp()).post('/upload');
    expect(res.status).toBe(401);
    expect(res.body.code).toBeUndefined();
  });
});
