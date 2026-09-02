/**
 * The admin event search must treat the search box as literal text.
 *
 * escapeLikePattern() used to double single quotes — SQL string-literal syntax
 * applied to a value that is BOUND, so "Sarah's Birthday" went to the database
 * as "Sarah''s Birthday" and matched nothing. It also emitted `\%` with no
 * ESCAPE clause on the LIKE, which Postgres honours and SQLite does not: on
 * SQLite the backslash was matched literally, so a search for a name containing
 * a real `%` or `_` returned nothing while the same search worked on Postgres.
 *
 * These run against SQLite (the engine the suite boots), which is the side that
 * silently returned zero rows.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-events-search-')), 'db.sqlite'
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'admin-events-search-secret';

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('../integration/helpers/crmDb');
const { escapeLikePattern } = require('../../src/utils/sqlSecurity');

async function insertEvent(db, adminId, eventName) {
  const rand = Math.random().toString(16).slice(2);
  await db('events').insert({
    slug: `ev-${rand}`,
    event_type: 'wedding',
    event_name: eventName,
    event_date: '2026-05-29',
    host_email: 'host@example.com',
    admin_email: 'admin@example.com',
    password_hash: 'x',
    share_link: `/gallery/share-${rand}`,
    share_token: `st-${rand}`,
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    is_active: 1, is_archived: 0, is_draft: 0,
    created_by: adminId,
    created_at: new Date().toISOString(),
  });
}

describe('GET /api/admin/events search — LIKE metacharacters and quotes', () => {
  let db; let cleanup; let app; let token;

  // Each metacharacter name is paired with a name a wildcard reading of the
  // search term would also match, so "matches only itself" is testable.
  const fixtures = [
    'Sarah\'s Birthday',
    'Sarahs Birthday',
    'Summer 100% Sale',
    'Summer 100X Sale',
    'Gala_Night',
    'GalaXNight',
  ];

  const search = async (term) => {
    const res = await request(app)
      .get('/api/admin/events')
      .query({ search: term })
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return res.body.events.map((e) => e.event_name).sort();
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    await assignAdminRole(db, adminId, 'super_admin');
    token = mintAdminToken(adminId);

    for (const name of fixtures) {
      await insertEvent(db, adminId, name);
    }

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin/events', require('../../src/routes/adminEvents'));
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
      res.status(err.statusCode || err.status || 500).json({ error: err.message, code: err.code });
    });
  }, 120000);

  afterAll(async () => { await cleanup(); });

  it('finds a name containing an apostrophe', async () => {
    expect(await search('Sarah\'s')).toEqual(['Sarah\'s Birthday']);
  });

  it('matches a literal % against itself only, not as a wildcard', async () => {
    expect(await search('100%')).toEqual(['Summer 100% Sale']);
  });

  it('matches a literal _ against itself only, not as a single-char wildcard', async () => {
    expect(await search('Gala_')).toEqual(['Gala_Night']);
  });

  it('still does substring matching for ordinary terms', async () => {
    expect(await search('Summer')).toEqual(['Summer 100% Sale', 'Summer 100X Sale']);
  });

  it('escapes only the LIKE metacharacters, leaving quotes untouched', () => {
    expect(escapeLikePattern('Sarah\'s Birthday')).toBe('Sarah\'s Birthday');
    expect(escapeLikePattern('100%_x')).toBe('100\\%\\_x');
    expect(escapeLikePattern('back\\slash')).toBe('back\\\\slash');
    expect(escapeLikePattern(null)).toBe('');
  });
});
