/**
 * getProjectOverview stamps each email with `canAct` — whether the queued-mail
 * routes (requireOwnedQueuedEmail) would actually accept an action on it.
 *
 * The cockpit used to derive this client-side from `event_id != null`, which is
 * weaker than the backend rule in a way that still produced dead controls:
 * requireOwnedQueuedEmail ALSO requires ownership of that event, while
 * getProjectOverview lists the project's events by project_id alone. Project
 * ownership does not imply event ownership — ownedProjectsSubquery's
 * `projects.created_by = admin.id` branch places no constraint on the linked
 * events' owners, so a super_admin can attach admin B's event to admin A's
 * project. See #969 / codex review round 1.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-canact-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'canact-test-secret';

const bcrypt = require('bcrypt');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

describe('getProjectOverview email canAct (#969)', () => {
  let db; let cleanup; let projectService;
  let adminA; let adminB; let superAdmin;
  let projectId; let ownEventId; let foreignEventId; let ownerlessEventId;

  const mkAdmin = async (username, roleName) => {
    const role = await db('roles').where({ name: roleName }).first();
    const r = await db('admin_users').insert({
      username, email: `${username}@example.com`,
      password_hash: await bcrypt.hash('Passw0rd!', 4),
      role_id: role.id, is_active: 1,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).returning('id');
    return r[0]?.id ?? r[0];
  };

  const mkEvent = async (slug, createdBy, project) => {
    const r = await db('events').insert({
      slug, event_type: 'wedding', event_name: slug, event_date: '2026-08-01',
      host_email: 'h@e.com', admin_email: 'a@e.com', password_hash: 'x',
      share_token: `t-${slug}`, share_link: `/g/${slug}/t-${slug}`,
      created_by: createdBy, project_id: project,
      expires_at: new Date(Date.now() + 864e5).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id');
    return r[0]?.id ?? r[0];
  };

  const mkMail = async (eventId, type) => {
    const r = await db('email_queue').insert({
      recipient_email: 'kunde@example.com', email_type: type, status: 'sent',
      event_id: eventId,
      created_at: new Date().toISOString(), sent_at: new Date().toISOString(),
    }).returning('id');
    return r[0]?.id ?? r[0];
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    projectService = require('../../src/services/projectService');

    adminA = await mkAdmin('canact-a', 'editor');
    adminB = await mkAdmin('canact-b', 'editor');
    superAdmin = await mkAdmin('canact-root', 'super_admin');

    const p = await db('projects').insert({
      name: 'Cockpit canAct', status: 'active', created_by: adminA,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).returning('id');
    projectId = p[0]?.id ?? p[0];

    // All three hang off adminA's project. Only the first is adminA's; the
    // third is an ownerless legacy row, which filterOwnedEventIds treats as
    // owned by whoever asks — but only once we know who is asking.
    ownEventId = await mkEvent('canact-own', adminA, projectId);
    foreignEventId = await mkEvent('canact-foreign', adminB, projectId);
    ownerlessEventId = await mkEvent('canact-legacy', null, projectId);

    await mkMail(ownEventId, 'gallery_ready');
    await mkMail(foreignEventId, 'gallery_ready');
    await mkMail(ownerlessEventId, 'gallery_ready');
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  const byEvent = (overview) => {
    const m = new Map();
    for (const e of overview.emails) m.set(e.eventId, e);
    return m;
  };

  it('clears mail on an event the caller owns', async () => {
    const overview = await projectService.getProjectOverview(
      projectId, {}, { id: adminA, roleName: 'editor' },
    );
    expect(byEvent(overview).get(ownEventId).canAct).toBe(true);
  });

  it('denies mail on a foreign admin\'s event inside the caller\'s own project', async () => {
    const overview = await projectService.getProjectOverview(
      projectId, {}, { id: adminA, roleName: 'editor' },
    );
    // event_id is non-null here — the old client-side rule would have offered
    // controls, and requireOwnedQueuedEmail would have 404'd them.
    const row = byEvent(overview).get(foreignEventId);
    expect(row.eventId).not.toBeNull();
    expect(row.canAct).toBe(false);
  });

  it('clears everything for a super_admin', async () => {
    const overview = await projectService.getProjectOverview(
      projectId, {}, { id: superAdmin, roleName: 'super_admin' },
    );
    expect(overview.emails.every((e) => e.canAct === true)).toBe(true);
  });

  it('clears mail on an ownerless legacy event for an identified caller', async () => {
    // Parity with filterOwnedEventIds, which allows created_by IS NULL.
    const overview = await projectService.getProjectOverview(
      projectId, {}, { id: adminA, roleName: 'editor' },
    );
    expect(byEvent(overview).get(ownerlessEventId).canAct).toBe(true);
  });

  it('denies everything when no admin context is supplied', async () => {
    // Including the ownerless event: `created_by == null` must not read as
    // "owned" when we do not know who is asking (codex review round 2).
    const overview = await projectService.getProjectOverview(projectId, {});
    expect(overview.emails.length).toBe(3);
    expect(overview.emails.every((e) => e.canAct === false)).toBe(true);
  });

  it('does not leak event ownership to the client', async () => {
    const overview = await projectService.getProjectOverview(
      projectId, {}, { id: adminA, roleName: 'editor' },
    );
    expect(overview.events.length).toBe(3);
    for (const e of overview.events) expect(e).not.toHaveProperty('created_by');
  });
});
