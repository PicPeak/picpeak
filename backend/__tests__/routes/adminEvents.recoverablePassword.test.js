/**
 * Opt-in recoverable gallery passwords (#1271).
 *
 * Off by default: nothing reversible is stored, the view route says so, and
 * resend falls back to the security sentinel. On: every path that hashes a
 * gallery or client password keeps an encrypted copy, the view route returns
 * it and logs the reveal, resend uses it unchanged, disabling the gallery
 * password clears it, and switching the setting off purges every copy.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-recover-')), 'db.sqlite');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'recover-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-recover-storage-'));

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const bcrypt = require('bcrypt');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('../integration/helpers/crmDb');
const vault = require('../../src/utils/galleryPasswordVault');

const PASSWORD = 'Meadow-Lark-77!';
const PIN = '432100';

describe('recoverable gallery passwords', () => {
  let db; let cleanup; let app; let token; let adminId;
  const auth = (req) => req.set('Authorization', `Bearer ${token}`);
  const setSetting = (value) => db('app_settings').insert({
    setting_key: vault.SETTING_KEY, setting_value: JSON.stringify(value), setting_type: 'security',
  }).onConflict('setting_key').merge({ setting_value: JSON.stringify(value) });
  const createEvent = (over = {}) => auth(request(app).post('/api/admin/events')).send({
    event_type: 'wedding', event_name: 'Recover Wedding', event_date: '2026-09-07',
    customer_name: 'Ada', customer_email: 'ada@example.com', admin_email: 'admin@example.com',
    require_password: true, password: PASSWORD, expiration_days: 30,
    client_access_enabled: true, client_password: PIN, ...over,
  });
  const stored = (id) => db('events').where('id', id).first('password_recoverable', 'client_password_recoverable');

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId } = await seedMinimal(db));
    await assignAdminRole(db, adminId, 'super_admin');
    token = mintAdminToken(adminId);
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin/events', require('../../src/routes/adminEvents'));
    app.use('/api/admin/settings', require('../../src/routes/adminSettings'));
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => { res.status(err.statusCode || err.status || 500).json({ error: err.message, code: err.code }); });
  }, 120000);
  afterAll(async () => { if (cleanup) await cleanup(); });

  it('encrypts and decrypts, and a different ciphertext each time', () => {
    const a = vault.encryptPassword(PASSWORD); const b = vault.encryptPassword(PASSWORD);
    expect(a).not.toBe(b);
    expect(vault.decryptPassword(a)).toBe(PASSWORD);
    // flip one ciphertext character so the tamper is never a no-op
    const [iv, tag, ct] = a.split('.');
    const tampered = [iv, tag, (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1)].join('.');
    expect(() => vault.decryptPassword(tampered)).toThrow();
  });

  it('purges before the write when turning on and after it when off, never on a same-state on save', async () => {
    // off → on: leftovers go first, so a copy stored under the new "on" is
    // never deleted by the purge; on → off and off → off: after, so a write
    // that still read "on" is caught (see purgePlanForSettingWrite).
    expect(await vault.purgePlanForSettingWrite(true)).toEqual({ before: true, after: false });
    expect(await vault.purgePlanForSettingWrite(false)).toEqual({ before: false, after: true });
    await setSetting(true);
    expect(await vault.purgePlanForSettingWrite('1')).toEqual({ before: false, after: false });
    expect(await vault.purgePlanForSettingWrite(false)).toEqual({ before: false, after: true });
    await setSetting(false);
  });

  it('with the setting off, creation stores nothing and the view route says the feature is off', async () => {
    const res = await createEvent();
    expect([200, 201]).toContain(res.status);
    const row = await stored(res.body.id);
    expect(row.password_recoverable).toBeNull();
    expect(row.client_password_recoverable).toBeNull();
    const view = await auth(request(app).get(`/api/admin/events/${res.body.id}/password`));
    expect(view.status).toBe(200);
    expect(view.body).toEqual({ enabled: false, password: null, client_password: null });
    // the hash still works, i.e. nothing about login changed
    const ev = await db('events').where('id', res.body.id).first();
    expect(await bcrypt.compare(PASSWORD, ev.password_hash)).toBe(true);
  });

  describe('with the setting on', () => {
    let id;
    beforeAll(async () => {
      await setSetting(true);
      const res = await createEvent();
      expect([200, 201]).toContain(res.status);
      id = res.body.id;
    });

    it('creation keeps an encrypted copy of both passwords, never the plaintext', async () => {
      const row = await stored(id);
      expect(row.password_recoverable).toBeTruthy();
      expect(row.password_recoverable).not.toContain(PASSWORD);
      expect(vault.decryptPassword(row.password_recoverable)).toBe(PASSWORD);
      expect(vault.decryptPassword(row.client_password_recoverable)).toBe(PIN);
    });

    it('the view route returns them and writes an activity-log entry', async () => {
      const view = await auth(request(app).get(`/api/admin/events/${id}/password`));
      expect(view.status).toBe(200);
      expect(view.body).toEqual({ enabled: true, password: PASSWORD, client_password: PIN });
      const log = await db('activity_logs').where({ activity_type: 'gallery_password_viewed' }).orderBy('id', 'desc').first();
      expect(log).toBeTruthy();
      expect(String(log.event_id)).toBe(String(id));
    });

    it('resend uses the stored password instead of the security sentinel', async () => {
      const res = await auth(request(app).post(`/api/admin/events/${id}/resend-email`)).send({});
      expect(res.status).toBe(200);
      expect(res.body.usedStoredPassword).toBe(true);
      const mail = await db('email_queue').where({ event_id: id, email_type: 'gallery_created' }).orderBy('id', 'desc').first();
      const data = JSON.parse(mail.email_data);
      expect(data.gallery_password).toBe(PASSWORD);
      // client access is on for this event: the resend carries the stored PIN
      // and the client link, as the creation mail did
      expect(data.client_password).toBe(PIN);
      expect(data.client_link).toMatch(/\/client-access\?token=[0-9a-f]+$/);
    });

    it('a reset replaces the stored copy', async () => {
      const res = await auth(request(app).post(`/api/admin/events/${id}/reset-password`)).send({ sendEmail: false, password: 'Harbour-Light-91!' });
      expect(res.status).toBe(200);
      expect(vault.decryptPassword((await stored(id)).password_recoverable)).toBe('Harbour-Light-91!');
    });

    it('editing the client PIN and the gallery password updates the copies', async () => {
      const res = await auth(request(app).put(`/api/admin/events/${id}`)).send({ client_password: '999900', password: 'Quiet-River-33!' });
      expect(res.status).toBe(200);
      const row = await stored(id);
      expect(vault.decryptPassword(row.client_password_recoverable)).toBe('999900');
      expect(vault.decryptPassword(row.password_recoverable)).toBe('Quiet-River-33!');
    });

    it('turning the gallery password off clears its copy', async () => {
      const res = await auth(request(app).put(`/api/admin/events/${id}`)).send({ require_password: false });
      expect(res.status).toBe(200);
      const row = await stored(id);
      expect(row.password_recoverable).toBeNull();
      expect(row.client_password_recoverable).toBeTruthy();
    });

    it('switching the setting on again does not resurrect leftovers', async () => {
      await setSetting(false);
      const leftover = await createEvent({ event_name: 'Leftover Wedding' });
      // a copy that survived the purge somehow (a write racing the switch-off)
      await db('events').where('id', leftover.body.id).update({ password_recoverable: vault.encryptPassword('Leftover-1!') });
      const res = await auth(request(app).put('/api/admin/settings/security')).send({ [vault.SETTING_KEY]: true });
      expect(res.status).toBe(200);
      expect((await stored(leftover.body.id)).password_recoverable).toBeNull();
      // and a value the API may send as 1/"1" keeps the vault (no purge on a same-state save)
      const keep = await createEvent({ event_name: 'Kept Wedding' });
      expect((await stored(keep.body.id)).password_recoverable).toBeTruthy();
      const same = await auth(request(app).put('/api/admin/settings/security')).send({ [vault.SETTING_KEY]: '1' });
      expect(same.status).toBe(200);
      expect((await stored(keep.body.id)).password_recoverable).toBeTruthy();
    });

    it('a creation in flight while the setting is switched off leaves no copy behind', async () => {
      // The setting is read while the insert is assembled, then the client
      // PIN hash awaits (crud.js). A switch-off that lands in that gap used to
      // be overtaken by the insert; the write-site re-check clears the row.
      const realHash = bcrypt.hash;
      const spy = jest.spyOn(bcrypt, 'hash').mockImplementation(async (...args) => {
        if (args[0] === PIN) {
          const off = await auth(request(app).put('/api/admin/settings/security')).send({ [vault.SETTING_KEY]: false });
          expect(off.status).toBe(200);
        }
        return realHash.apply(bcrypt, args);
      });
      try {
        const res = await createEvent({ event_name: 'Racing Wedding' });
        expect([200, 201]).toContain(res.status);
        const row = await stored(res.body.id);
        expect(row.password_recoverable).toBeNull();
        expect(row.client_password_recoverable).toBeNull();
      } finally {
        spy.mockRestore();
        await setSetting(true);
      }
    });

    it('switching the setting off purges every stored copy', async () => {
      const other = await createEvent({ event_name: 'Second Wedding' });
      expect((await stored(other.body.id)).password_recoverable).toBeTruthy();
      const res = await auth(request(app).put('/api/admin/settings/security')).send({ [vault.SETTING_KEY]: false });
      expect(res.status).toBe(200);
      for (const eid of [id, other.body.id]) {
        const row = await stored(eid);
        expect(row.password_recoverable).toBeNull();
        expect(row.client_password_recoverable).toBeNull();
      }
      const view = await auth(request(app).get(`/api/admin/events/${other.body.id}/password`));
      expect(view.body.enabled).toBe(false);
      // and resend is back to the sentinel
      const resend = await auth(request(app).post(`/api/admin/events/${other.body.id}/resend-email`)).send({});
      expect(resend.body.usedStoredPassword).toBe(false);
    });
  });
});
