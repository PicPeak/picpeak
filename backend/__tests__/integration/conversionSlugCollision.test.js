/**
 * A gallery made from a quote or a standalone contract gets a slug with a
 * random part. It used to be inserted without any check: a clash with a live
 * gallery failed the insert, and a clash with a renamed gallery's old slug
 * took over that gallery's old links. The conversion now draws again until
 * the slug is free, like create and rename check theirs.
 */
const crypto = require('crypto');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

jest.setTimeout(120000);

describe('slug of a gallery converted from a quote or a contract', () => {
  let db; let cleanup; let adminId; let customerId;
  let quoteService; let contractConversions;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId, customerId } = await seedMinimal(db));
    quoteService = require('../../src/services/quoteService');
    contractConversions = require('../../src/services/contract/conversions');
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });
  afterEach(() => { jest.restoreAllMocks(); });

  // The first 3-byte draw returns `aaaaaa`, every later one is random.
  function firstSuffix() {
    const real = crypto.randomBytes;
    let drawn = false;
    jest.spyOn(crypto, 'randomBytes').mockImplementation((size, ...rest) => {
      if (size === 3 && !drawn) {
        drawn = true;
        return Buffer.from('aaaaaa', 'hex');
      }
      return real.call(crypto, size, ...rest);
    });
  }

  async function acceptedQuote() {
    const dealUuid = crypto.randomUUID();
    const quoteNumber = `Q-${dealUuid.slice(0, 8)}`;
    const [row] = await db('quotes').insert({
      quote_number: quoteNumber,
      customer_account_id: customerId,
      status: 'accepted',
      currency: 'CHF',
      issue_date: '2026-01-01',
      net_amount_minor: 100000, vat_amount_minor: 0, shipping_amount_minor: 0, total_amount_minor: 100000,
      deal_uuid: dealUuid,
      created_by_admin_id: adminId,
    }).returning('id');
    return { id: row?.id ?? row, slug: `quote-${quoteNumber.toLowerCase()}-aaaaaa` };
  }

  async function signedContract() {
    const contractNumber = `C-${crypto.randomBytes(4).toString('hex')}`;
    const [row] = await db('contracts').insert({
      customer_account_id: customerId,
      contract_number: contractNumber,
      status: 'fully_signed',
      issue_date: '2026-01-01',
      created_at: new Date().toISOString(),
    }).returning('id');
    return { id: row?.id ?? row, slug: `contract-${contractNumber.toLowerCase()}-aaaaaa` };
  }

  async function gallery(slug) {
    const [row] = await db('events').insert({
      slug,
      event_name: `Gallery ${slug}`,
      event_type: 'wedding',
      event_date: '2026-01-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'not-a-real-hash',
      share_link: `/gallery/${slug}`,
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      is_active: true,
      created_at: new Date().toISOString(),
    }).returning('id');
    return row?.id ?? row;
  }

  // A gallery renamed away from `oldSlug`: its old links follow the redirect.
  async function renamedFrom(oldSlug) {
    const newSlug = `${oldSlug}-renamed`;
    const id = await gallery(newSlug);
    await db('slug_redirects').insert({
      old_slug: oldSlug, new_slug: newSlug, event_id: id, created_at: new Date().toISOString(),
    });
    return id;
  }

  const convert = {
    quote: async () => {
      const q = await acceptedQuote();
      return { taken: q.slug, run: () => quoteService.convertToEvent(q.id, adminId, { hold: true, skipInvoices: true }) };
    },
    contract: async () => {
      const c = await signedContract();
      return { taken: c.slug, run: () => contractConversions.convertToEvent(c.id, adminId) };
    },
  };

  it.each(['quote', 'contract'])('a %s conversion skips a slug a live gallery holds', async (kind) => {
    const { taken, run } = await convert[kind]();
    const holder = await gallery(taken);
    firstSuffix();
    const res = await run();
    const ev = await db('events').where({ id: res.eventId }).first();
    expect(ev.slug).not.toBe(taken);
    expect((await db('events').where({ slug: taken }).first()).id).toBe(holder);
  });

  it.each(['quote', 'contract'])('a %s conversion skips a renamed gallery\'s old slug', async (kind) => {
    const { taken, run } = await convert[kind]();
    const renamed = await renamedFrom(taken);
    firstSuffix();
    const res = await run();
    const ev = await db('events').where({ id: res.eventId }).first();
    expect(ev.slug).not.toBe(taken);
    const { followSlugRedirect } = require('../../src/services/slugRedirects');
    expect((await followSlugRedirect(taken))?.id).toBe(renamed);
  });
});
