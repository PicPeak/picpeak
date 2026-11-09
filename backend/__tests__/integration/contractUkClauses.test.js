/**
 * Contract clauses for a business in the United Kingdom (issue 2439).
 *
 * A UK business's new contract swaps the European closing provisions, the
 * GDPR / FADP data-protection clause and the tiered cancellation fees for
 * UK clauses, adds the moral-rights assertion and the portfolio consent after
 * the image-rights clauses, and — for a consumer customer only — the 14-day
 * cancellation notice. A business anywhere else never gets a UK clause.
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
const UK_ALWAYS = ['closing_jurisdiction_gb', 'data_protection_uk', 'deposit_cancellation_gb', 'moral_rights_gb', 'portfolio_consent_gb'];
const UK_CONSUMER = 'consumer_cancellation_gb';

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  ({ adminId, customerId } = await seedMinimal(db));
  await db('customer_accounts').where({ id: customerId }).update({
    first_name: 'Sam', last_name: 'Taylor', company_name: null, vat_id: null, customer_kind: null,
  });
});

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

const crud = () => require('../../src/services/contract/crud');

async function createContract(payload = {}) {
  return { id: await crud().createContract({ customerAccountId: customerId, ...payload }, adminId) };
}

async function clauses(contractId) {
  return db('contract_block_inclusions as i')
    .join('contract_blocks as b', 'b.id', 'i.block_id')
    .where('i.contract_id', contractId)
    .orderBy('i.position', 'asc')
    .select('b.slug', 'i.section');
}

const slugsOf = async (contractId) => (await clauses(contractId)).map((c) => c.slug);
const setCountry = (countryCode) => db('business_profile').where({ id: 1 }).update({ country_code: countryCode });
const setCustomer = (fields) => db('customer_accounts').where({ id: customerId }).update(fields);

describe('a business outside the UK', () => {
  beforeAll(() => setCountry('CH'));

  test('never gets a UK clause', async () => {
    const slugs = await slugsOf((await createContract()).id);
    expect(slugs).toEqual(expect.arrayContaining([...EUROPEAN_ONLY, 'cancellation_tiered']));
    for (const slug of [...UK_ALWAYS, UK_CONSUMER]) expect(slugs).not.toContain(slug);
  });
});

describe('a UK business', () => {
  beforeAll(() => setCountry('GB'));
  afterAll(() => setCustomer({ company_name: null, customer_kind: null }));

  test('swaps the European and tiered clauses for the UK ones', async () => {
    const slugs = await slugsOf((await createContract()).id);
    expect(slugs).toEqual(expect.arrayContaining(UK_ALWAYS));
    for (const slug of [...EUROPEAN_ONLY, 'cancellation_tiered', 'closing_jurisdiction_us']) {
      expect(slugs).not.toContain(slug);
    }
    expect(slugs).toEqual(expect.arrayContaining(['basics_service', 'image_rights_private', 'payment_terms_reference']));
  });

  test('keeps each clause in its place, and positions run 1..n', async () => {
    const { id } = await createContract();
    const list = await clauses(id);
    expect(list[list.length - 1]).toEqual({ slug: 'closing_jurisdiction_gb', section: 'closing' });
    const slugs = list.map((c) => c.slug);
    expect(slugs.indexOf('moral_rights_gb')).toBeGreaterThan(slugs.indexOf('image_rights_commercial'));
    expect(slugs.indexOf('portfolio_consent_gb')).toBe(slugs.indexOf('moral_rights_gb') + 1);
    expect(slugs.indexOf(UK_CONSUMER)).toBe(slugs.indexOf('deposit_cancellation_gb') + 1);
    const positions = (await db('contract_block_inclusions').where({ contract_id: id }).orderBy('position'))
      .map((row) => row.position);
    expect(positions).toEqual(positions.map((_, i) => i + 1));
  });

  test('gives a private customer the 14-day cancellation notice', async () => {
    await setCustomer({ company_name: null, vat_id: null, customer_kind: null });
    expect(await slugsOf((await createContract()).id)).toContain(UK_CONSUMER);
  });

  test('leaves it out for a customer with a company name', async () => {
    await setCustomer({ company_name: 'Band Ltd', customer_kind: null });
    expect(await slugsOf((await createContract()).id)).not.toContain(UK_CONSUMER);
  });

  test('follows the explicit kind over the company name', async () => {
    await setCustomer({ company_name: 'Band Ltd', customer_kind: 'consumer' });
    expect(await slugsOf((await createContract()).id)).toContain(UK_CONSUMER);
    await setCustomer({ company_name: null, customer_kind: 'business' });
    expect(await slugsOf((await createContract()).id)).not.toContain(UK_CONSUMER);
  });

  test('names the chosen jurisdiction in the closing provisions', async () => {
    await db('business_profile').where({ id: 1 }).update({ jurisdiction: 'scotland' });
    const { id } = await createContract({ language: 'en' });
    const { contract, inclusions, textSections } = await crud().getContractById(id);
    const ctx = await require('../../src/services/contract/renderContext').buildRenderContext(contract, inclusions, textSections);
    const body = ctx.sections.flatMap((section) => section.blocks).map((block) => block.body).join('\n');
    expect(body).toContain('governed by the law of Scotland');
    await db('business_profile').where({ id: 1 }).update({ jurisdiction: null });
  });
});

describe('the editor sends its own clause list', () => {
  const library = () => require('../../src/services/contractBlocksService');
  afterAll(() => setCountry('CH'));

  test('a UK business starts from the UK clauses', async () => {
    await setCountry('GB');
    const slugs = (await library().listBlocks({ forNewContract: true })).map((block) => block.slug);
    expect(slugs).toEqual(expect.arrayContaining([...UK_ALWAYS, UK_CONSUMER]));
    for (const slug of [...EUROPEAN_ONLY, 'cancellation_tiered']) expect(slugs).not.toContain(slug);
  });

  test('a stale client cannot put UK clauses on a business elsewhere', async () => {
    await setCountry('DE');
    const all = await db('contract_blocks').where({ is_system: true, is_active: true }).select('id');
    const { id } = await createContract({ blocks: all.map((b) => ({ blockId: b.id, included: true })) });
    const slugs = await slugsOf(id);
    for (const slug of [...UK_ALWAYS, UK_CONSUMER]) expect(slugs).not.toContain(slug);
  });
});

describe('a contract made from a quote', () => {
  afterAll(() => setCountry('CH'));

  test('a UK business gets the UK clauses', async () => {
    await setCountry('GB');
    const quotes = require('../../src/services/quoteService');
    const created = await quotes.createQuote({
      customerAccountId: customerId, language: 'en', currency: 'GBP', vatRate: 20,
      lineItems: [{ description: 'Music video shoot', quantity: 1, unitPriceMinor: 120000, kind: 'item' }],
    }, adminId);
    const quoteId = created.id || created;
    await db('quotes').where({ id: quoteId }).update({ status: 'accepted', accepted_at: new Date().toISOString() });
    const { contractId } = await require('../../src/services/contractService').createFromQuote(quoteId, adminId);
    const slugs = await slugsOf(contractId);
    expect(slugs).toEqual(expect.arrayContaining(UK_ALWAYS));
    for (const slug of EUROPEAN_ONLY) expect(slugs).not.toContain(slug);
  });
});

describe('a retired UK clause', () => {
  afterAll(async () => {
    await db('contract_blocks').where({ slug: 'deposit_cancellation_gb' }).update({ is_active: true });
    await setCountry('CH');
  });

  test('leaves the tiered cancellation clause in place of the deposit clause', async () => {
    await setCountry('GB');
    await db('contract_blocks').where({ slug: 'deposit_cancellation_gb' }).update({ is_active: false });
    const slugs = await slugsOf((await createContract()).id);
    expect(slugs).toContain('cancellation_tiered');
    expect(slugs).not.toContain('deposit_cancellation_gb');
  });
});

describe('without any contract template', () => {
  beforeAll(async () => {
    await db('contract_template_version_items').del();
    await db('contract_template_versions').del();
    await db('contract_templates').del();
  });
  afterAll(() => setCountry('CH'));

  test('a UK business still gets the UK clauses from the system blocks', async () => {
    await setCountry('GB');
    await setCustomer({ company_name: 'Band Ltd', customer_kind: null });
    const slugs = await slugsOf((await createContract()).id);
    expect(slugs).toEqual(expect.arrayContaining(UK_ALWAYS));
    expect(slugs).not.toContain(UK_CONSUMER);
    for (const slug of [...EUROPEAN_ONLY, 'cancellation_tiered']) expect(slugs).not.toContain(slug);
  });
});

describe('a new contract from the editor\'s own clause list', () => {
  beforeAll(() => setCountry('GB'));
  afterAll(async () => { await setCountry('CH'); await setCustomer({ company_name: null, customer_kind: null }); });
  const listed = async () => (await require('../../src/services/contractBlocksService').listBlocks({ forNewContract: true }))
    .map((b) => ({ blockId: b.id, included: true }));

  test('leaves the consumer clause out for a business customer', async () => {
    await setCustomer({ company_name: 'Band Ltd', customer_kind: null });
    const { id } = await createContract({ blocks: await listed() });
    expect(await slugsOf(id)).not.toContain(UK_CONSUMER);
  });

  test('keeps it for a consumer', async () => {
    await setCustomer({ company_name: null, vat_id: null, customer_kind: 'consumer' });
    const { id } = await createContract({ blocks: await listed() });
    expect(await slugsOf(id)).toContain(UK_CONSUMER);
  });

  test('a later save can still add it for a business customer', async () => {
    await setCustomer({ company_name: 'Band Ltd', customer_kind: null });
    const blocks = await listed();
    const { id } = await createContract({ blocks });
    await crud().updateContract(id, { blocks }, adminId);
    expect(await slugsOf(id)).toContain(UK_CONSUMER);
  });
});
