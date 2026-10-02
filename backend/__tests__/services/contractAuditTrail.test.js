/**
 * getAuditTrail() filters activity_logs by the contractId inside the
 * JSON metadata column. The column is `json` on Postgres (db.js creates it
 * with table.json), and Postgres has no `json LIKE text` operator, so the
 * old `where('metadata', 'like', …)` raised "operator does not exist:
 * json ~~ unknown" and the audit-trail endpoint answered 500. SQLite
 * stores the same column as TEXT and never noticed.
 *
 * The fix casts the column to TEXT before matching, which both engines
 * accept. The suite runs on SQLite, so the behaviour half runs for real
 * and the Postgres half is pinned by asserting the SQL knex emits.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-contract-audit-')), 'db.sqlite'
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'contract-audit-trail-secret';

const { bootCrmDb } = require('../integration/helpers/crmDb');

describe('contract audit trail — metadata.contractId filter', () => {
  let db; let cleanup; let getAuditTrail;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ getAuditTrail } = require('../../src/services/contractService'));

    const now = new Date().toISOString();
    const row = (activity_type, metadata) => ({
      activity_type, actor_type: 'admin', actor_id: 1, actor_name: 'Admin', metadata, created_at: now,
    });
    await db('activity_logs').insert([
      row('contract_sent', JSON.stringify({ contractId: 7, to: 'a@example.com' })),
      // Whitespaced encoding, as a hand-written or pretty-printed writer would produce.
      row('contract_signed', '{"contractId": 7, "by": "customer"}'),
      row('contract_sent', JSON.stringify({ contractId: 8 })),
      // Same id, but not a contract_* activity: must stay out of the trail.
      row('invoice_sent', JSON.stringify({ contractId: 7 })),
    ]);
  }, 120000);

  afterAll(async () => { await cleanup(); });

  it('returns only the contract_* rows whose metadata names the contract, metadata parsed', async () => {
    const rows = await getAuditTrail(7);
    expect(rows.map((r) => r.activity_type)).toEqual(['contract_sent', 'contract_signed']);
    expect(rows.map((r) => r.metadata.contractId)).toEqual([7, 7]);
    expect(await getAuditTrail(8)).toHaveLength(1);
    expect(await getAuditTrail(9)).toEqual([]);
  });

  it('casts the json column to TEXT before LIKE so the query also runs on Postgres', async () => {
    const seen = [];
    const onQuery = (q) => { seen.push(q.sql); };
    db.on('query', onQuery);
    try {
      await getAuditTrail(7);
    } finally {
      db.removeListener('query', onQuery);
    }
    const select = seen.find((sql) => sql.includes('from `activity_logs`'));
    expect(select).toBeDefined();
    expect(select).toContain('CAST(metadata AS TEXT) LIKE ?');
    expect(select).not.toMatch(/`metadata`\s+like/i);
  });
});
