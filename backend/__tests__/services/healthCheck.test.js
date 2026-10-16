'use strict';

const express = require('express');
const request = require('supertest');
const { createHealthHandlers } = require('../../src/services/healthCheck');

// /health and /api/health are public. They say whether the process can serve
// and nothing else: the process id and uptime told any visitor when the
// server last restarted.
describe('public health answer', () => {
  function appWith({ fenced = false, restartRequired = false, dbFails = false } = {}) {
    const db = { raw: jest.fn(async () => { if (dbFails) throw new Error('db down'); }) };
    const restoreCoordinator = { isFenced: () => fenced, status: () => ({ restartRequired }) };
    const logger = { error: jest.fn() };
    const health = createHealthHandlers({ db, restoreCoordinator, logger });
    const app = express();
    app.get(['/health', '/api/health'], health.duringRestore);
    app.get(['/health', '/api/health'], health.ordinary);
    return { app, db };
  }

  it.each(['/health', '/api/health'])('%s answers only the status', async (route) => {
    const response = await request(appWith().app).get(route).expect(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('a failed database probe answers 503 with only the status', async () => {
    const response = await request(appWith({ dbFails: true }).app).get('/health').expect(503);
    expect(response.body).toEqual({ status: 'error' });
  });

  it('during a restore it answers from memory, keeping the maintenance state', async () => {
    const restoring = appWith({ fenced: true });
    const response = await request(restoring.app).get('/health').expect(200);
    expect(response.body).toEqual({ status: 'ok', maintenance: 'restoring' });
    expect(restoring.db.raw).not.toHaveBeenCalled();
    const restart = await request(appWith({ fenced: true, restartRequired: true }).app).get('/api/health').expect(200);
    expect(restart.body).toEqual({ status: 'ok', maintenance: 'restart_required' });
  });
});
