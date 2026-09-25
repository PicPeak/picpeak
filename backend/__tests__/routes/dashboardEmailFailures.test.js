/**
 * The dashboard's "failed emails in the last 24 hours" counts by created_at
 * (issue 1670).
 *
 * It used to filter on scheduled_at >= <ISO string>. Mail that goes out at
 * once now has scheduled_at NULL, which that filter never matches on either
 * engine, and on SQLite an ISO bind never matched the millisecond rows the
 * queue stores anyway. The bind is engine-shaped now (a Date on Postgres,
 * milliseconds on SQLite), so the count is real on both.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-dash-mail-'));
process.env.STORAGE_PATH = tmp;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-that-is-long-enough-for-validation';

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('../integration/helpers/crmDb');

const HOUR = 3600 * 1000;

describe('GET /api/admin/dashboard/health — failed emails of the last day', () => {
  let db; let cleanup; let app; let token;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    await assignAdminRole(db, adminId, 'super_admin');
    token = mintAdminToken(adminId);

    const now = Date.now();
    await db('email_queue').del();
    const failed = (email_type, createdAt) => db('email_queue').insert({
      recipient_email: 'a@b.c', email_type, status: 'failed', retry_count: 3,
      created_at: createdAt, scheduled_at: null,
    });
    // Two failures from today with the NULL schedule every immediate email
    // carries now, one from last week, one still pending.
    await failed('today_a', now - HOUR);
    await failed('today_b', now - 2 * HOUR);
    await failed('last_week', now - 7 * 24 * HOUR);
    await db('email_queue').insert({
      recipient_email: 'a@b.c', email_type: 'pending', status: 'pending', retry_count: 0,
      created_at: now - HOUR, scheduled_at: null,
    });

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin/dashboard', require('../../src/routes/adminDashboard'));
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('counts the failures created in the last 24 hours, schedule or none', async () => {
    const res = await request(app).get('/api/admin/dashboard/health').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Number(res.body.details.emailQueue.failed)).toBe(2);
    expect(Number(res.body.details.emailQueue.pending)).toBe(1);
  });
});
