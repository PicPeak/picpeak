/**
 * Contract clauses for a business in the United States.
 *
 * The seeded closing provisions name Swiss or German law and the
 * data-protection clause cites the GDPR and the Swiss FADP. A US business's
 * new contract leaves those out and closes with the US closing provisions
 * instead, in the same place; a business anywhere else gets the clauses it
 * always did and never the US one. An English contract prints each clause
 * under its English title rather than the German block name.
 */

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;
let tmpDir;
let adminId;
let customerId;
const prevCwd = process.cwd();

const EUROPEAN_ONLY = ['closing_jurisdiction_ch', 'closing_jurisdiction_de', 'dsgvo_data_protection'];

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  ({ adminId, customerId } = await seedMinimal(db));
  await db('customer_accounts').where({ id: customerId }).update({ first_name: 'Jordan', last_name: 'Rivera' });
});

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

const crud = () => require('../../src/services/contract/crud');

async function createContract(payload = {}) {
  const id = await crud().createContract({ customerAccountId: customerId, ...payload }, adminId);
  return { id };
}

async function clauses(contractId) {
  return db('contract_block_inclusions as i')
    .join('contract_blocks as b', 'b.id', 'i.block_id')
    .where('i.contract_id', contractId)
    .orderBy('i.position', 'asc')
    .select('b.slug', 'i.section');
}

const setCountry = (countryCode) => db('business_profile').where({ id: 1 }).update({ country_code: countryCode });

describe('a business outside the US', () => {
  beforeAll(() => setCountry('LI'));

  test('keeps the Swiss and German closing provisions and the data-protection clause', async () => {
    const slugs = (await clauses((await createContract()).id)).map((c) => c.slug);
    expect(slugs).toEqual(expect.arrayContaining(EUROPEAN_ONLY));
    expect(slugs).not.toContain('closing_jurisdiction_us');
  });
});

describe('a US business', () => {
  beforeAll(() => setCountry('US'));

  test('closes a new contract under US law instead of Swiss or German law', async () => {
    const slugs = (await clauses((await createContract()).id)).map((c) => c.slug);
    expect(slugs).toContain('closing_jurisdiction_us');
    for (const slug of EUROPEAN_ONLY) expect(slugs).not.toContain(slug);
  });

  test('puts the US closing provisions where the closing provisions always were: last', async () => {
    const list = await clauses((await createContract()).id);
    expect(list[list.length - 1]).toEqual({ slug: 'closing_jurisdiction_us', section: 'closing' });
  });

  test('keeps every other clause of the standard contract', async () => {
    const slugs = (await clauses((await createContract()).id)).map((c) => c.slug);
    expect(slugs).toEqual(expect.arrayContaining([
      'basics_service', 'image_rights_private', 'payment_terms_reference', 'cancellation_tiered',
    ]));
  });
});

describe('clause headings', () => {
  async function headings(language) {
    const contract = await createContract({ language });
    const { contract: row, inclusions, textSections } = await crud().getContractById(contract.id);
    const ctx = await require('../../src/services/contract/renderContext').buildRenderContext(row, inclusions, textSections);
    return ctx.sections.flatMap((section) => section.blocks.map((block) => block.name));
  }

  test('an English contract prints each clause under its English title', async () => {
    const names = await headings('en');
    expect(names).toContain('Subject of contract');
    expect(names).not.toContain('Vertragsgegenstand (Foto-/Videoauftrag)');
  });

  test('a German contract keeps the block names', async () => {
    expect(await headings('de')).toContain('Vertragsgegenstand (Foto-/Videoauftrag)');
  });
});

describe('without any contract template', () => {
  // A new contract falls back to the active system blocks when no template
  // version can be found (the standard one removed).
  beforeAll(async () => {
    await db('contract_template_version_items').del();
    await db('contract_template_versions').del();
    await db('contract_templates').del();
  });

  test('a US business still closes under US law', async () => {
    await setCountry('US');
    const slugs = (await clauses((await createContract()).id)).map((c) => c.slug);
    expect(slugs).toContain('closing_jurisdiction_us');
    for (const slug of EUROPEAN_ONLY) expect(slugs).not.toContain(slug);
  });

  test('a business elsewhere never gets the US closing provisions', async () => {
    await setCountry('DE');
    const slugs = (await clauses((await createContract()).id)).map((c) => c.slug);
    expect(slugs).toEqual(expect.arrayContaining(EUROPEAN_ONLY));
    expect(slugs).not.toContain('closing_jurisdiction_us');
  });
});
