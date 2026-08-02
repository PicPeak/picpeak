/**
 * Project ownership edge cases (GHSA-wrg5, codex round 2).
 *
 * The first predicate union'd "any linked event I can see" with the stored
 * owner, which opened two holes:
 *   - a project owned by B containing ONE legacy ownerless event became
 *     readable by everyone (and /overview aggregates B's other events,
 *     invoices and emails);
 *   - migration 167 deliberately leaves multi-owner projects NULL, and a NULL
 *     owner was treated as "everyone's".
 * The stored owner is now authoritative, and a NULL owner only derives access
 * when EVERY linked event is accessible.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-projedge-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'projedge-test-secret';

const bcrypt3 = require('bcrypt');
const { bootCrmDb: boot3, seedMinimal: seed3 } = require('../integration/helpers/crmDb');

describe('project ownership edge cases (GHSA-wrg5, round 2)', () => {
  let db3; let cleanup3; let ownership; let editorA; let editorB;

  const mkAdmin3 = async (username, roleName) => {
    const role = await db3('roles').where({ name: roleName }).first();
    const r = await db3('admin_users').insert({
      username, email: `${username}@example.com`,
      password_hash: await bcrypt3.hash('Passw0rd!', 4),
      role_id: role.id, is_active: 1,
      created_at: new Date(), updated_at: new Date(),
    }).returning('id');
    return r[0]?.id ?? r[0];
  };
  const mkProject3 = async (name, createdBy) => {
    const r = await db3('projects').insert({
      name, status: 'active', created_by: createdBy,
      created_at: new Date(), updated_at: new Date(),
    }).returning('id');
    return r[0]?.id ?? r[0];
  };
  const mkEvent3 = async (slug, createdBy, projectId) => {
    const r = await db3('events').insert({
      slug, event_type: 'wedding', event_name: slug, event_date: '2026-08-01',
      host_email: 'h@e.com', admin_email: 'a@e.com', password_hash: 'x',
      share_token: `t-${slug}`, share_link: `/g/${slug}/t-${slug}`,
      created_by: createdBy, project_id: projectId,
      expires_at: new Date(Date.now() + 864e5).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id');
    return r[0]?.id ?? r[0];
  };

  beforeAll(async () => {
    ({ db: db3, cleanup: cleanup3 } = await boot3());
    await seed3(db3);
    ownership = require('../../src/middleware/ownership');
    editorA = await mkAdmin3('edge-a', 'editor');
    editorB = await mkAdmin3('edge-b', 'editor');
  }, 120000);

  afterAll(async () => { if (cleanup3) await cleanup3(); });

  it('one ownerless event in B\'s project does not expose it to A', async () => {
    const pid = await mkProject3('b-project', editorB);
    await mkEvent3('b-owned-ev', editorB, pid);
    await mkEvent3('legacy-ev', null, pid); // ownerless legacy event

    const idsA = await ownership.ownedProjectIds({ id: editorA, roleName: 'editor' });
    expect(idsA).not.toContain(Number(pid));

    const idsB = await ownership.ownedProjectIds({ id: editorB, roleName: 'editor' });
    expect(idsB).toContain(Number(pid));
  });

  it('a mixed-owner project left NULL by migration 167 is not global', async () => {
    const pid = await mkProject3('ambiguous', null);
    await mkEvent3('mix-a-ev', editorA, pid);
    await mkEvent3('mix-b-ev', editorB, pid);

    for (const who of [editorA, editorB]) {
      const ids = await ownership.ownedProjectIds({ id: who, roleName: 'editor' });
      expect(ids).not.toContain(Number(pid));
    }
  });

  it('a NULL-owner project whose events are all mine IS mine', async () => {
    const pid = await mkProject3('legacy-mine', null);
    await mkEvent3('mine-ev', editorA, pid);

    const ids = await ownership.ownedProjectIds({ id: editorA, roleName: 'editor' });
    expect(ids).toContain(Number(pid));
  });

  it('a project whose creator was deleted falls back to its events', async () => {
    const ghost = await mkAdmin3('ghost-admin', 'editor');
    const pid = await mkProject3('orphaned', ghost);
    await mkEvent3('orphan-ev', editorA, pid);
    await db3('admin_users').where({ id: ghost }).del();

    const ids = await ownership.ownedProjectIds({ id: editorA, roleName: 'editor' });
    expect(ids).toContain(Number(pid));
  });

  it('super_admin stays unrestricted', async () => {
    expect(await ownership.ownedProjectIds({ id: 1, roleName: 'super_admin' })).toBeNull();
  });
});
