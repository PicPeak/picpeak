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

describe('the editor sends its own clause list', () => {
  const systemBlocks = () => db('contract_blocks').where({ is_system: true, is_active: true }).select('id', 'slug');
  const entries = (blocks) => blocks.map((block) => ({ blockId: block.id, included: true }));
  const library = () => require('../../src/services/contractBlocksService');

  afterAll(() => setCountry('LI'));

  test('a new contract starts from the clauses for the business\'s legal system', async () => {
    await setCountry('LI');
    let slugs = (await library().listBlocks({ forNewContract: true })).map((block) => block.slug);
    expect(slugs).toEqual(expect.arrayContaining(EUROPEAN_ONLY));
    expect(slugs).not.toContain('closing_jurisdiction_us');

    await setCountry('US');
    slugs = (await library().listBlocks({ forNewContract: true })).map((block) => block.slug);
    expect(slugs).toContain('closing_jurisdiction_us');
    for (const slug of EUROPEAN_ONLY) expect(slugs).not.toContain(slug);
  });

  test('the block library still lists every clause', async () => {
    await setCountry('LI');
    const slugs = (await library().listBlocks()).map((block) => block.slug);
    expect(slugs).toEqual(expect.arrayContaining([...EUROPEAN_ONLY, 'closing_jurisdiction_us']));
  });

  test('a stale client cannot put US law on a business elsewhere', async () => {
    await setCountry('CH');
    const { id } = await createContract({ blocks: entries(await systemBlocks()) });
    const slugs = (await clauses(id)).map((c) => c.slug);
    expect(slugs).toEqual(expect.arrayContaining(EUROPEAN_ONLY));
    expect(slugs).not.toContain('closing_jurisdiction_us');
  });

  test('a stale client cannot put Swiss or German law on a US business', async () => {
    await setCountry('US');
    const { id } = await createContract({ blocks: entries(await systemBlocks()) });
    const slugs = (await clauses(id)).map((c) => c.slug);
    expect(slugs).toContain('closing_jurisdiction_us');
    for (const slug of EUROPEAN_ONLY) expect(slugs).not.toContain(slug);
  });

  test('saving a draft keeps the clauses it already holds, after the country changed', async () => {
    await setCountry('LI');
    const { id } = await createContract();
    const held = await db('contract_block_inclusions').where({ contract_id: id }).select('block_id');
    await setCountry('US');
    await crud().updateContract(id, { blocks: held.map((row) => ({ blockId: row.block_id, included: true })) }, adminId);
    expect((await clauses(id)).map((c) => c.slug)).toEqual(expect.arrayContaining(EUROPEAN_ONLY));
  });
});

describe('a contract made from a quote', () => {
  afterAll(() => setCountry('LI'));

  async function converted() {
    const quotes = require('../../src/services/quoteService');
    const quoteId = await quotes.createQuote({
      customerAccountId: customerId, language: 'en', currency: 'USD', vatRate: 0,
      lineItems: [{ description: 'Full session', quantity: 1, unitPriceMinor: 17500, kind: 'item' }],
    }, adminId);
    await db('quotes').where({ id: quoteId.id || quoteId }).update({ status: 'accepted', accepted_at: new Date().toISOString() });
    const { contractId } = await require('../../src/services/contractService').createFromQuote(quoteId.id || quoteId, adminId);
    return contractId;
  }

  test('a US business closes under US law', async () => {
    await setCountry('US');
    const slugs = (await clauses(await converted())).map((c) => c.slug);
    expect(slugs).toContain('closing_jurisdiction_us');
    for (const slug of EUROPEAN_ONLY) expect(slugs).not.toContain(slug);
  });

  test('a business elsewhere keeps its clauses', async () => {
    await setCountry('DE');
    const slugs = (await clauses(await converted())).map((c) => c.slug);
    expect(slugs).toEqual(expect.arrayContaining(EUROPEAN_ONLY));
    expect(slugs).not.toContain('closing_jurisdiction_us');
  });
});

describe('a retired US clause', () => {
  afterAll(async () => {
    await db('contract_blocks').where({ slug: 'closing_jurisdiction_us' }).update({ is_active: true });
    await setCountry('LI');
  });

  test('still leaves Swiss and German law out of a US contract', async () => {
    await setCountry('US');
    await db('contract_blocks').where({ slug: 'closing_jurisdiction_us' }).update({ is_active: false });
    const slugs = (await clauses((await createContract()).id)).map((c) => c.slug);
    for (const slug of EUROPEAN_ONLY) expect(slugs).not.toContain(slug);
  });
});

describe('headings outside the PDF', () => {
  beforeAll(() => setCountry('LI'));

  const names = (view) => view.sections.flatMap((section) => section.blocks.map((block) => block.name));

  test('the signing page prints the headings the PDF prints', async () => {
    const { id } = await createContract({ language: 'en' });
    const views = require('../../src/services/publicDocumentViews');
    expect(names(await views.buildContractView(id))).toContain('Subject of contract');
  });

  test('a contract sent before format 4 keeps its block names there too', async () => {
    const { id } = await createContract({ language: 'en' });
    await db('contracts').where({ id }).update({
      sent_at: new Date().toISOString(), rendered_content: JSON.stringify({ format: 3, clauses: [] }),
    });
    const views = require('../../src/services/publicDocumentViews');
    expect(names(await views.buildContractView(id))).not.toContain('Subject of contract');
  });

  test('the template preview prints the headings the contract will', async () => {
    const templates = require('../../src/services/contract/templates');
    const version = await templates.resolveVersionForNewContract(null);
    const clause = version.items.find((item) => item.block_slug === 'basics_service');
    expect(Boolean(clause.block_is_system)).toBe(true);
  });
});

describe('a clause an admin wrote', () => {
  test('keeps the name they gave it in an English contract', async () => {
    const [row] = await db('contract_blocks').insert({
      slug: 'own_clause_abc123', section: 'closing', name: 'Our delivery promise',
      body_text: '**Delivery**\n\nWithin four weeks.', body_text_de: '**Lieferung**\n\nIn vier Wochen.',
      is_system: false, is_active: true, display_order: 99,
    }).returning('id');
    const blockId = typeof row === 'object' ? row.id : row;
    const { id } = await createContract({ language: 'en', blocks: [{ blockId, included: true }] });
    const { contract, inclusions, textSections } = await crud().getContractById(id);
    const ctx = await require('../../src/services/contract/renderContext').buildRenderContext(contract, inclusions, textSections);
    const [block] = ctx.sections.flatMap((section) => section.blocks);
    expect(block.name).toBe('Our delivery promise');
    expect(block.body).not.toContain('**Delivery**');
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
