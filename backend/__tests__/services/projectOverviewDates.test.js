/**
 * getProjectOverview sends its documents' `date` columns as bare days
 * (issue 2333). PostgreSQL returns them as Dates at local midnight, which
 * res.json turns into "…T00:00:00.000Z", a day early west of UTC, and which
 * sorted apart from the same row on SQLite in the project activity feed.
 * SQLite hands back whatever text was stored, so a stored instant stands in
 * for the pg shape here.
 */

const crypto = require('crypto');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

describe('getProjectOverview document dates (issue 2333)', () => {
  let db; let cleanup; let projectService; let adminId; let customerId; let projectId;
  const idOf = (row) => (typeof row === 'object' ? row.id : row);

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId, customerId } = await seedMinimal(db));
    projectService = require('../../src/services/projectService');
    const [p] = await db('projects').insert({
      name: 'Dates', status: 'active', customer_account_id: customerId, created_by: adminId,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).returning('id');
    projectId = idOf(p);
    await db('quotes').insert({
      quote_number: 'Q-DATES-1', customer_account_id: customerId, status: 'sent', currency: 'CHF',
      issue_date: '2026-10-05T00:00:00.000Z', valid_until: '2026-11-04T00:00:00.000Z',
      net_amount_minor: 100, vat_amount_minor: 0, shipping_amount_minor: 0, total_amount_minor: 100,
      deal_uuid: crypto.randomUUID(), project_id: projectId, created_by_admin_id: adminId,
    });
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('sends quote dates and the quote milestone as YYYY-MM-DD', async () => {
    const out = await projectService.getProjectOverview(projectId, {}, { id: adminId, roleName: 'super_admin' });
    expect(out.quotes).toHaveLength(1);
    expect(out.quotes[0]).toMatchObject({ issue_date: '2026-10-05', valid_until: '2026-11-04' });
    expect(out.milestones.find((m) => m.kind === 'quote')).toMatchObject({ date: '2026-10-05' });
  });
});
