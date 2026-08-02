/**
 * Deal-lineage ownership on project attach (GHSA-wrg5, codex round 3).
 *
 * requireProjectOwnership vets only the DESTINATION project. Attaching a quote
 * cascades through linkDealToProject, which re-points every event the deal
 * produced into that project — so an editor could create an empty project of
 * their own, attach another admin's quote, and pull that admin's events (and
 * the invoices, emails and gallery that roll up with them) into a project they
 * own and can read via /:id/overview. An unassigned project offered no
 * resistance either: it ADOPTS the deal's customer rather than rejecting it.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-deallineage-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'deallineage-test-secret';

const bcrypt = require('bcrypt');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

describe('linkDealToProject enforces lineage ownership (GHSA-wrg5, round 3)', () => {
  let db; let cleanup; let projectService;
  let editorA; let editorB; let superAdmin;
  let customerId;

  const mkAdmin = async (username, roleName) => {
    const role = await db('roles').where({ name: roleName }).first();
    const r = await db('admin_users').insert({
      username, email: `${username}@example.com`,
      password_hash: await bcrypt.hash('Passw0rd!', 4),
      role_id: role.id, is_active: 1,
      created_at: new Date(), updated_at: new Date(),
    }).returning('id');
    return r[0]?.id ?? r[0];
  };
  const mkProject = async (name, createdBy) => {
    const r = await db('projects').insert({
      name, status: 'active', created_by: createdBy,
      created_at: new Date(), updated_at: new Date(),
    }).returning('id');
    return r[0]?.id ?? r[0];
  };
  const mkEvent = async (slug, createdBy) => {
    const r = await db('events').insert({
      slug, event_type: 'wedding', event_name: slug, event_date: '2026-08-01',
      host_email: 'h@e.com', admin_email: 'a@e.com', password_hash: 'x',
      share_token: `t-${slug}`, share_link: `/g/${slug}/t-${slug}`,
      created_by: createdBy,
      expires_at: new Date(Date.now() + 864e5).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id');
    return r[0]?.id ?? r[0];
  };
  const mkQuote = async (dealUuid, convertedEventId) => {
    const r = await db('quotes').insert({
      quote_number: `Q-${dealUuid}`,
      customer_account_id: customerId,
      deal_uuid: dealUuid,
      converted_event_id: convertedEventId,
      status: 'accepted',
      currency: 'EUR',
      issue_date: '2026-08-01',
      total_amount_minor: 1000,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).returning('id');
    return r[0]?.id ?? r[0];
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    projectService = require('../../src/services/projectService');
    editorA = await mkAdmin('deal-a', 'editor');
    editorB = await mkAdmin('deal-b', 'editor');
    superAdmin = await mkAdmin('deal-root', 'super_admin');
    const c = await db('customer_accounts').first('id');
    customerId = c.id;
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it("refuses to move another admin's event into the caller's project", async () => {
    const victimEvent = await mkEvent('victim-gala', editorB);
    const quoteId = await mkQuote('deal-foreign', victimEvent);
    const attackerProject = await mkProject('attacker-empty', editorA);

    await expect(
      projectService.assignQuote(attackerProject, quoteId, { id: editorA, roleName: 'editor' }),
    ).rejects.toMatchObject({ code: 'DEAL_EVENT_FORBIDDEN' });

    // Nothing may be half-applied: neither the event nor the quote moved.
    const ev = await db('events').where({ id: victimEvent }).first('project_id');
    expect(ev.project_id == null).toBe(true);
    const q = await db('quotes').where({ id: quoteId }).first('project_id');
    expect(q.project_id == null).toBe(true);
  });

  it("allows the caller's own event through the same path", async () => {
    const ownEvent = await mkEvent('own-gala', editorA);
    const quoteId = await mkQuote('deal-own', ownEvent);
    const project = await mkProject('attacker-own', editorA);

    await projectService.assignQuote(project, quoteId, { id: editorA, roleName: 'editor' });

    const ev = await db('events').where({ id: ownEvent }).first('project_id');
    expect(Number(ev.project_id)).toBe(Number(project));
  });

  it('leaves super_admin unrestricted', async () => {
    const victimEvent = await mkEvent('root-gala', editorB);
    const quoteId = await mkQuote('deal-root', victimEvent);
    const project = await mkProject('root-project', superAdmin);

    await projectService.assignQuote(project, quoteId, { id: superAdmin, roleName: 'super_admin' });

    const ev = await db('events').where({ id: victimEvent }).first('project_id');
    expect(Number(ev.project_id)).toBe(Number(project));
  });

  it('resolves the role from a bare admin id (quote/contract create+update paths)', async () => {
    // Those services thread `adminId`, not req.admin — the lookup must still
    // scope them, and must fail closed rather than assume super_admin.
    const victimEvent = await mkEvent('bare-gala', editorB);
    const quoteId = await mkQuote('deal-bare', victimEvent);
    const project = await mkProject('bare-project', editorA);

    await expect(
      projectService.assignQuote(project, quoteId, { id: editorA }),
    ).rejects.toMatchObject({ code: 'DEAL_EVENT_FORBIDDEN' });
  });
});
