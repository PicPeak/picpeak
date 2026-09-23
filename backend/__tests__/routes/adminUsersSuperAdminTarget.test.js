/**
 * PUT /api/admin/users/:id must not be a weaker path to changes the dedicated
 * routes guard.
 *
 * users.edit is delegable. A holder that is not super_admin must not rewrite a
 * super_admin's profile. Email changes also decide whether a later SSO login
 * may link to the account by email (admin_users.email_link_eligible,
 * migration 227).
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-users-target-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'users-target-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-users-target-storage-'));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken,
} = require('../integration/helpers/crmDb');
const svc = require('../../src/services/userManagementService');
const { clearPermissionCache } = require('../../src/middleware/permissions');

describe('PUT /api/admin/users/:id — super_admin targets', () => {
  let db; let cleanup; let app;
  let superId; let superTok;
  let clerkId; let clerkTok;
  let removerTok;
  let otherId;

  const auth = (req, tok) => req.set('Authorization', `Bearer ${tok}`);
  const row = (id) => db('admin_users').where({ id }).first();
  const insertAdmin = async (fields) => {
    const ins = await db('admin_users').insert({
      password_hash: 'x', must_change_password: false, is_active: true, created_at: new Date(), ...fields,
    }).returning('id');
    return ins[0]?.id ?? ins[0];
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId: superId } = await seedMinimal(db));
    await assignAdminRole(db, superId, 'super_admin');
    superTok = mintAdminToken(superId);

    // A delegated user manager: users.view + users.edit, nothing else.
    const clerkRole = await svc.createRole(
      { name: 'user_clerk', permissions: ['users.view', 'users.edit'] },
      superId,
    );
    clerkId = await insertAdmin({ username: 'clerk', email: 'clerk@example.com', role_id: clerkRole.id });
    clerkTok = mintAdminToken(clerkId);

    // A delegated account manager for the lifecycle routes: users.delete only.
    const removerRole = await svc.createRole(
      { name: 'user_remover', permissions: ['users.view', 'users.delete'] },
      superId,
    );
    const removerId = await insertAdmin({ username: 'remover', email: 'remover@example.com', role_id: removerRole.id });
    removerTok = mintAdminToken(removerId);

    const viewer = await db('roles').where({ name: 'viewer' }).first();
    otherId = await insertAdmin({ username: 'other', email: 'other@example.com', role_id: viewer && viewer.id });
    clearPermissionCache();

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin/users', require('../../src/routes/adminUsers'));
    app.use('/api/admin/auth', require('../../src/routes/adminAuth'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('refuses a users.edit holder rewriting a super_admin\'s email', async () => {
    const before = await row(superId);
    const res = await auth(request(app).put(`/api/admin/users/${superId}`), clerkTok)
      .send({ email: 'attacker@example.com' });
    expect(res.status).toBe(403);
    expect((await row(superId)).email).toBe(before.email);
  });

  it('marks an email set by a non-super admin as not eligible for SSO email linking', async () => {
    const res = await auth(request(app).put(`/api/admin/users/${otherId}`), clerkTok)
      .send({ email: 'changed-by-clerk@example.com' });
    expect(res.status).toBe(200);
    const r = await row(otherId);
    expect(r.email).toBe('changed-by-clerk@example.com');
    expect(Boolean(r.email_link_eligible)).toBe(false);
  });

  it('marks a self-edited profile email as not eligible for SSO email linking', async () => {
    const res = await auth(request(app).put('/api/admin/auth/profile'), clerkTok)
      .send({ username: 'clerk', email: 'someone-else@example.com' });
    expect(res.status).toBe(200);
    const r = await row(clerkId);
    expect(r.email).toBe('someone-else@example.com');
    expect(Boolean(r.email_link_eligible)).toBe(false);
  });

  it('marks an email set by a super_admin as eligible again', async () => {
    const res = await auth(request(app).put(`/api/admin/users/${otherId}`), superTok)
      .send({ email: 'set-by-owner@example.com' });
    expect(res.status).toBe(200);
    expect(Boolean((await row(otherId)).email_link_eligible)).toBe(true);
  });

  it('lets a super_admin confirm an email by saving it unchanged', async () => {
    await db('admin_users').where({ id: otherId }).update({ email_link_eligible: false });
    const { email } = await row(otherId);
    const res = await auth(request(app).put(`/api/admin/users/${otherId}`), superTok).send({ email });
    expect(res.status).toBe(200);
    expect(Boolean((await row(otherId)).email_link_eligible)).toBe(true);
  });

  it('exposes the SSO eligibility on the list, and a super_admin confirmation flips it back', async () => {
    // What the Users page does: it reads the flag off the list and, on the
    // "Confirm email for SSO" action, PUTs the address back unchanged.
    const viewer = await db('roles').where({ name: 'viewer' }).first();
    const target = await insertAdmin({ username: 'sso-target', email: 'sso-target@example.com', role_id: viewer && viewer.id });

    await auth(request(app).put(`/api/admin/users/${target}`), clerkTok)
      .send({ email: 'sso-target-moved@example.com' }).expect(200);

    let list = await auth(request(app).get('/api/admin/users'), superTok);
    expect(list.status).toBe(200);
    expect(list.body.users.find((u) => u.id === target).emailLinkEligible).toBe(false);

    const { email } = await row(target);
    await auth(request(app).put(`/api/admin/users/${target}`), superTok).send({ email }).expect(200);

    list = await auth(request(app).get('/api/admin/users'), superTok);
    expect(list.body.users.find((u) => u.id === target).emailLinkEligible).toBe(true);
  });

  it('keeps the eligibility to itself on a list read by anyone else', async () => {
    // Only a super_admin can confirm an address, so only a super_admin is told
    // which rows an IdP assertion could link onto.
    const list = await auth(request(app).get('/api/admin/users'), clerkTok);
    expect(list.status).toBe(200);
    expect(list.body.users.every((u) => u.emailLinkEligible === undefined)).toBe(true);
  });

  it('leaves a non-eligible row alone when a users.edit holder re-saves the address', async () => {
    // The UI action rests on this: only a super_admin lifts the flag, and
    // re-saving the same address must not lift it for anyone else.
    const viewer = await db('roles').where({ name: 'viewer' }).first();
    const target = await insertAdmin({ username: 'stays-false', email: 'stays-false@example.com', role_id: viewer && viewer.id });
    await db('admin_users').where({ id: target }).update({ email_link_eligible: false });

    const { email } = await row(target);
    await auth(request(app).put(`/api/admin/users/${target}`), clerkTok).send({ email }).expect(200);

    expect(Boolean((await row(target)).email_link_eligible)).toBe(false);
  });

  it('does not rewrite the stored address when it is only re-confirmed', async () => {
    // normalizeEmail lowercases; confirming must not edit a mixed-case address.
    const viewer = await db('roles').where({ name: 'viewer' }).first();
    const target = await insertAdmin({ username: 'mixed-case', email: 'Mixed.Case@Example.com', role_id: viewer && viewer.id });
    await db('admin_users').where({ id: target }).update({ email_link_eligible: false });

    await auth(request(app).put(`/api/admin/users/${target}`), superTok)
      .send({ email: 'Mixed.Case@Example.com' }).expect(200);

    const after = await row(target);
    expect(after.email).toBe('Mixed.Case@Example.com');
    expect(Boolean(after.email_link_eligible)).toBe(true);
  });

  it('refuses a second admin the same address in different case', async () => {
    // Same class as the OIDC lookup: two rows differing only in case would
    // both answer to one IdP claim.
    const viewer = await db('roles').where({ name: 'viewer' }).first();
    await insertAdmin({ username: 'case-owner', email: 'Case.Owner@Example.com', role_id: viewer && viewer.id });
    const other = await insertAdmin({ username: 'case-taker', email: 'case-taker@example.com', role_id: viewer && viewer.id });

    const res = await auth(request(app).put(`/api/admin/users/${other}`), superTok)
      .send({ email: 'case.owner@example.com' });

    expect(res.status).toBe(409);
    expect((await row(other)).email).toBe('case-taker@example.com');
  });

  it('refuses the confirmation when the address changes under it', async () => {
    // updateAdminUser reads the row, then writes only the flag. If the target
    // changes their own email in between (PUT /admin/auth/profile, which sets
    // eligibility false), the confirmation must not land on that new address.
    const viewer = await db('roles').where({ name: 'viewer' }).first();
    const target = await insertAdmin({ username: 'racer', email: 'racer@example.com', role_id: viewer && viewer.id });
    await db('admin_users').where({ id: target }).update({ email_link_eligible: false });

    // Same shape as the retention race test: a knex builder is lazy, so
    // .then() queues the competing write on SQLite's single connection the
    // moment the service issues its first read of this row.
    let raced = null;
    const onQuery = (q) => {
      if (!raced && /^select/i.test(q.sql) && q.sql.includes('admin_users')
        && (q.bindings || []).includes(target)) {
        raced = db('admin_users').where({ id: target })
          .update({ email: 'typed-by-the-owner@example.com' }).then(() => {});
      }
    };
    db.on('query', onQuery);
    let res;
    try {
      res = await auth(request(app).put(`/api/admin/users/${target}`), superTok)
        .send({ email: 'racer@example.com' });
    } finally {
      db.removeListener('query', onQuery);
    }
    await raced;

    expect(res.status).toBe(409);
    const after = await row(target);
    expect(after.email).toBe('typed-by-the-owner@example.com');
    expect(Boolean(after.email_link_eligible)).toBe(false);
  });

  it('sends no eligibility at all from a schema without the column', () => {
    // migration 227 may not have run yet; the key is then absent, which the
    // Users page reads as eligible and offers nothing on.
    const { transformUser } = require('../../src/routes/adminUsers').__test;
    const shaped = transformUser({ id: 1, username: 'old', email: 'old@example.com' }, { ssoEligibility: true });
    expect(shaped.emailLinkEligible).toBeUndefined();
  });

  describe('deactivate, activate and delete of a super_admin', () => {
    let targetId;
    beforeAll(async () => {
      targetId = await insertAdmin({ username: 'third-super', email: 'third@example.com' });
      await assignAdminRole(db, targetId, 'super_admin');
    });

    it('refuses a users.delete holder deactivating, activating or deleting a super_admin', async () => {
      let res = await auth(request(app).post(`/api/admin/users/${targetId}/deactivate`), removerTok);
      expect(res.status).toBe(403);
      expect(Boolean((await row(targetId)).is_active)).toBe(true);

      await db('admin_users').where({ id: targetId }).update({ is_active: false });
      res = await auth(request(app).post(`/api/admin/users/${targetId}/activate`), removerTok);
      expect(res.status).toBe(403);
      expect(Boolean((await row(targetId)).is_active)).toBe(false);
      await db('admin_users').where({ id: targetId }).update({ is_active: true });

      res = await auth(request(app).delete(`/api/admin/users/${targetId}`), removerTok);
      expect(res.status).toBe(403);
      expect(await row(targetId)).toBeTruthy();
    });

    it('still lets a users.delete holder deactivate an account that is not a super_admin', async () => {
      const res = await auth(request(app).post(`/api/admin/users/${otherId}/deactivate`), removerTok);
      expect(res.status).toBe(200);
      expect(Boolean((await row(otherId)).is_active)).toBe(false);
      await db('admin_users').where({ id: otherId }).update({ is_active: true });
    });

    it('lets a super_admin deactivate another super_admin', async () => {
      const res = await auth(request(app).post(`/api/admin/users/${targetId}/deactivate`), superTok);
      expect(res.status).toBe(200);
      expect(Boolean((await row(targetId)).is_active)).toBe(false);
    });
  });

});
