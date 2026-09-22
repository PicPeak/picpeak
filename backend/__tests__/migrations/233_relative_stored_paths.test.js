const path = require('path');
const knex = require('knex');
const { randomUUID } = require('crypto');
const migration = require('../../migrations/core/233_relative_stored_paths');

// SQLite by default; PICPEAK_PG_TEST_URL runs it on Postgres in a scratch schema.
const pgUrl = process.env.PICPEAK_PG_TEST_URL;
let db; let owner; let schema; let cleanup; let root; let customerId;

beforeAll(async () => {
  if (pgUrl) {
    schema = `stored_paths_${randomUUID().replace(/-/g, '')}`;
    owner = knex({ client: 'pg', connection: pgUrl });
    await owner.schema.createSchema(schema);
    process.env.DATABASE_CLIENT = 'pg';
    jest.doMock('../../knexfile', () => ({ client: 'pg', connection: pgUrl, searchPath: [schema] }));
  }
  const crm = require('../integration/helpers/crmDb');
  ({ db, cleanup } = await crm.bootCrmDb());
  ({ customerId } = await crm.seedMinimal(db));
  root = path.resolve(process.env.STORAGE_PATH);
});
afterAll(async () => {
  if (cleanup) await cleanup();
  if (owner) { await owner.schema.dropSchema(schema, true); await owner.destroy(); }
});

const doc = (p) => ({ doc_type: 'contract', doc_id: 1, kind: 'signed', path: p, sha256: 'a'.repeat(64), bytes: 1, generated_at: new Date().toISOString() });

test('absolute paths under the storage root become relative; everything else stays; down restores them', async () => {
  const under = path.join(root, 'business-docs', 'contract', '2026', 'C-1.pdf');
  const values = {
    under,
    foreign: '/app/storage/business-docs/contract/2026/C-2.pdf',
    lookalike: `${root}-old/business-docs/contract/2026/C-3.pdf`,
    relative: 'business-docs/contract/2026/C-4.pdf',
  };
  const ids = {};
  for (const [key, value] of Object.entries(values)) {
    const [row] = await db('generated_documents').insert(doc(value)).returning('id');
    ids[key] = row.id ?? row;
  }
  const [contract] = await db('contracts').insert({
    contract_number: 'C-MIG', customer_account_id: customerId, issue_date: '2026-09-22', status: 'fully_signed', title: 't',
    pdf_path: under,
    signed_pdf_path: path.join(root, 'uploads', 'contracts', 'signed', 'wet.pdf'),
    signed_admin_signature_path: null,
    pdf_sha256: 'b'.repeat(64),
  }).returning('id');
  const contractId = contract.id ?? contract;
  const read = async () => ({
    docs: Object.fromEntries(await Promise.all(Object.entries(ids).map(async ([k, id]) => [k, (await db('generated_documents').where({ id }).first()).path]))),
    contract: await db('contracts').where({ id: contractId }).first('pdf_path', 'signed_pdf_path', 'signed_admin_signature_path', 'pdf_sha256'),
  });

  await migration.up(db);
  const up = await read();
  expect(up.docs).toEqual({
    under: 'business-docs/contract/2026/C-1.pdf',
    foreign: values.foreign,
    lookalike: values.lookalike,
    relative: values.relative,
  });
  expect(up.contract).toEqual({
    pdf_path: 'business-docs/contract/2026/C-1.pdf',
    signed_pdf_path: 'uploads/contracts/signed/wet.pdf',
    signed_admin_signature_path: null,
    pdf_sha256: 'b'.repeat(64),
  });

  // Idempotent.
  await migration.up(db);
  expect(await read()).toEqual(up);

  // down(): back to absolute under the same root, so an older release reads them.
  await migration.down(db);
  const down = await read();
  expect(down.docs.under).toBe(under);
  expect(down.docs.relative).toBe(path.join(root, 'business-docs', 'contract', '2026', 'C-4.pdf'));
  expect(down.docs.foreign).toBe(values.foreign);
  expect(down.contract.pdf_path).toBe(under);

  // And up again round-trips.
  await migration.up(db);
  const again = await read();
  expect(again.contract).toEqual(up.contract);
  expect(again.docs.under).toBe(up.docs.under);
  expect(again.docs.relative).toBe(values.relative);
});
