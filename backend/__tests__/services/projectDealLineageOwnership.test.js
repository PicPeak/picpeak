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

  // The lineage guard above only fires once a deal has produced an event. The
  // quote/contract create+update paths call linkDealToProject with a
  // body-supplied projectId and NO route-level ownership guard, so a brand-new
  // deal (eventIds empty) skipped every check and wrote into a foreign project.
  describe('destination ownership (codex review follow-up)', () => {
    it('refuses a foreign project even when the deal has no events yet', async () => {
      const victimProject = await mkProject('victim-destination', editorB);
      const quoteId = await mkQuote('deal-no-events', null);

      await expect(
        projectService.linkDealToProject('deal-no-events', victimProject, db, { id: editorA }),
      ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });

      const q = await db('quotes').where({ id: quoteId }).first('project_id');
      expect(q.project_id == null).toBe(true);
    });

    it('refuses an OWNERLESS project with no events (the escalation path)', async () => {
      // created_by NULL + no linked events is exactly the shape that would let
      // the caller claim the project via ownedProjectsSubquery's second branch
      // once their quote converts to an event.
      const orphan = await mkProject('orphan-destination', null);
      await mkQuote('deal-orphan', null);

      await expect(
        projectService.linkDealToProject('deal-orphan', orphan, db, { id: editorA }),
      ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    });

    it("still allows the caller's own project with no events", async () => {
      const own = await mkProject('own-destination', editorA);
      const quoteId = await mkQuote('deal-own-dest', null);

      await projectService.linkDealToProject('deal-own-dest', own, db, { id: editorA });

      const q = await db('quotes').where({ id: quoteId }).first('project_id');
      expect(Number(q.project_id)).toBe(Number(own));
    });

    it('refuses a foreign project when the deal_uuid is NULL (codex round 1)', async () => {
      // deal_uuid is nullable (migration 107) and quoteService.update passes the
      // EXISTING row's value, so a legacy quote reaches linkDealToProject with
      // null. The old `if (!dealUuid || !projectId) return` bailed before the
      // guard — while the caller had already written project_id onto its row.
      const victimProject = await mkProject('victim-nulldeal', editorB);

      await expect(
        projectService.linkDealToProject(null, victimProject, db, { id: editorA }),
      ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    });

    it('still no-ops on a NULL deal_uuid pointed at the caller-s own project', async () => {
      // The destination is vetted, then it returns without cascading — there is
      // no lineage to move.
      const own = await mkProject('own-nulldeal', editorA);
      await expect(
        projectService.linkDealToProject(null, own, db, { id: editorA }),
      ).resolves.toBeUndefined();
    });

    it('does not leak customer association through the error code', async () => {
      // The customer check used to run first, so a foreign project whose
      // customer differed answered 422 PROJECT_CUSTOMER_MISMATCH while an
      // unknown id answered 404 — enough to enumerate projects and infer their
      // customer. Both must now be indistinguishable to a scoped caller.
      const foreignWithCustomer = await mkProject('victim-customer', editorB);
      await db('projects').where({ id: foreignWithCustomer }).update({ customer_account_id: customerId });
      await mkQuote('deal-oracle', null);

      await expect(
        projectService.linkDealToProject('deal-oracle', foreignWithCustomer, db, { id: editorA }),
      ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });

      await expect(
        projectService.linkDealToProject('deal-oracle', 999999, db, { id: editorA }),
      ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    });

    it('leaves super_admin unrestricted on a foreign destination', async () => {
      const victimProject = await mkProject('root-destination', editorB);
      const quoteId = await mkQuote('deal-root-dest', null);

      await projectService.linkDealToProject('deal-root-dest', victimProject, db, {
        id: superAdmin, roleName: 'super_admin',
      });

      const q = await db('quotes').where({ id: quoteId }).first('project_id');
      expect(Number(q.project_id)).toBe(Number(victimProject));
    });
  });
});
