const express = require('express');
const request = require('supertest');

jest.mock('../../src/database/db', () => ({ db: jest.fn(), logActivity: jest.fn() }));
jest.mock('../../src/middleware/auth', () => ({
  adminAuth: (req, res, next) => (req.headers.authorization ? next() : res.status(401).json({ error: 'Unauthorized' })),
}));
jest.mock('../../src/middleware/permissions', () => ({
  requirePermission: () => (req, res, next) => (req.headers['x-denied'] ? res.status(403).json({ error: 'Forbidden' }) : next()),
}));

const dependencyHealth = require('../../src/services/dependencyHealth');
const router = require('../../src/routes/adminSystemHealth');

const { logActivity } = require('../../src/database/db');

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.admin = { id: 7, username: 'luca' }; next(); });
app.use('/api/admin/system-health', router);

describe('GET /api/admin/system-health/status', () => {
  it('answers from memory, without touching the database', async () => {
    dependencyHealth.applyProbe('storage', { state: 'healthy' });
    const res = await request(app).get('/api/admin/system-health/status').set('Authorization', 'Bearer x');
    expect(res.status).toBe(200);
    expect(res.body.enforcement).toBe('observe');
    expect(res.body.dependencies.storage.state).toBe('healthy');
    expect(res.body.capabilities.map((c) => c.name)).toContain('uploads.new');
  });

  it('refuses an anonymous caller, since probe details can name hosts', async () => {
    const res = await request(app).get('/api/admin/system-health/status');
    expect(res.status).toBe(401);
    expect(res.body.dependencies).toBeUndefined();
  });

  it('refuses an admin without the permission', async () => {
    const res = await request(app).get('/api/admin/system-health/status')
      .set('Authorization', 'Bearer x').set('x-denied', '1');
    expect(res.status).toBe(403);
  });
});

describe('POST /api/admin/system-health/status/recheck', () => {
  it('audits who lifted a pause early', async () => {
    logActivity.mockClear();
    jest.spyOn(dependencyHealth, 'recheck').mockResolvedValue({ enforcement: 'observe' });
    const res = await request(app).post('/api/admin/system-health/status/recheck').set('Authorization', 'Bearer x');
    expect(res.status).toBe(200);
    expect(logActivity).toHaveBeenCalledWith('degradation_rechecked', {}, null, expect.objectContaining({ id: 7 }));
    jest.restoreAllMocks();
  });
});

describe('PUT /api/admin/system-health/status/settings', () => {
  const put = (body) => request(app).put('/api/admin/system-health/status/settings')
    .set('Authorization', 'Bearer x').send(body);

  beforeEach(() => {
    logActivity.mockClear();
    jest.spyOn(dependencyHealth, 'updateSettings').mockResolvedValue({ enforcement: 'enforce' });
  });
  afterEach(() => jest.restoreAllMocks());

  it('saves a valid change and audits who made it', async () => {
    const res = await put({ enforcement: 'enforce', forcedOff: ['uploads.new'] });
    expect(res.status).toBe(200);
    expect(logActivity).toHaveBeenCalledWith('degradation_settings_updated',
      { enforcement: 'enforce', forcedOff: ['uploads.new'] }, null, expect.objectContaining({ id: 7 }));
  });

  it.each([
    ['an unknown mode', { enforcement: 'bypass' }],
    ['a name outside the catalog', { forcedOff: ['auth.login'] }],
  ])('rejects %s', async (_label, body) => {
    const res = await put(body);
    expect(res.status).toBe(400);
    expect(dependencyHealth.updateSettings).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });

  it('saves thresholds with a gap between them', async () => {
    const res = await put({ cpuThresholds: { throttlePercent: 80, resumePercent: 60 } });
    expect(res.status).toBe(200);
    expect(dependencyHealth.updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      cpuThresholds: { throttlePercent: 80, resumePercent: 60 },
    }));
  });

  it.each([
    ['no gap', { cpuThresholds: { throttlePercent: 60, resumePercent: 60 } }, 'INVALID_LOAD_THRESHOLDS'],
    ['a limit that would throttle constantly', { cpuThresholds: { throttlePercent: 5, resumePercent: 2 } }, undefined],
    ['half a pair', { cpuThresholds: { throttlePercent: 80 } }, undefined],
  ])('rejects %s', async (_label, body, code) => {
    const res = await put(body);
    expect(res.status).toBe(400);
    if (code) expect(res.body.code).toBe(code);
    expect(dependencyHealth.updateSettings).not.toHaveBeenCalled();
  });

  it('needs an authenticated admin', async () => {
    const res = await request(app).put('/api/admin/system-health/status/settings').send({ enforcement: 'observe' });
    expect(res.status).toBe(401);
  });
});
