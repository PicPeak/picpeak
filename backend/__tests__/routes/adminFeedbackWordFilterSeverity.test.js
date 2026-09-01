/**
 * Word-filter severity vocabulary. The Settings → Moderation UI offers
 * low / moderate / high / block, but the validator only accepted the
 * unrelated mild / moderate / severe set, so 3 of the 4 levels — including
 * "block", the strongest tier — 400'd on every add.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-wfsev-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'wfsev-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-wfsev-storage-'));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('../integration/helpers/crmDb');

describe('word filter severity levels', () => {
  let db; let cleanup; let app; let superTok;

  const auth = (req) => req.set('Authorization', `Bearer ${superTok}`);

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId: superId } = await seedMinimal(db);
    await assignAdminRole(db, superId, 'super_admin');
    superTok = mintAdminToken(superId);

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin/feedback', require('../../src/routes/adminFeedback'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it.each(['low', 'moderate', 'high', 'block'])('accepts severity "%s"', async (severity) => {
    const word = `zzsev${severity}`;
    const res = await auth(request(app).post('/api/admin/feedback/word-filters'))
      .send({ word, severity });

    expect(res.status).toBe(200);
    const row = await db('feedback_word_filters').where({ word }).first();
    expect(row.severity).toBe(severity);
  });

  it('still rejects a severity outside the vocabulary', async () => {
    const res = await auth(request(app).post('/api/admin/feedback/word-filters'))
      .send({ word: 'zzsevbogus', severity: 'catastrophic' });

    expect(res.status).toBe(400);
    expect(res.body.errors.some((e) => e.path === 'severity')).toBe(true);
  });

  it('blocks a comment matching a "block" filter and only flags a "low" one', async () => {
    const moderation = require('../../src/services/feedbackModeration');
    moderation.clearCache();

    const blocked = await moderation.moderateText('this is zzsevblock speech');
    expect(blocked.approved).toBe(false);
    expect(blocked.violations.map((v) => v.word)).toEqual(['zzsevblock']);

    const flagged = await moderation.moderateText('this is zzsevlow speech');
    expect(flagged.approved).toBe(true);
    expect(flagged.flagged).toBe(true);
  });
});
