'use strict';

// Customer erasure reaches the copies of the customer's details that other
// records keep: the contact columns on their galleries and the stored
// context of their workflow runs.
const crypto = require('crypto');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

let db, cleanup, adminId;
const idOf = row => row?.id ?? row;
let serial = 0;

async function customer() {
  serial += 1;
  const email = `erase-copy-${serial}@example.test`;
  const [row] = await db('customer_accounts').insert({ email, display_name: `Erase Copy ${serial}`, first_name: 'Vera',
    last_name: `Copy${serial}`, phone: '+00 111 1111', preferred_language: 'de', is_active: 1, created_at: new Date() }).returning('id');
  return { id: idOf(row), email };
}

async function galleryFromQuote(customerId) {
  const dealUuid = crypto.randomUUID();
  const [row] = await db('quotes').insert({ quote_number: `Q-${dealUuid.slice(0, 8)}`, customer_account_id: customerId,
    status: 'accepted', currency: 'CHF', issue_date: '2027-02-01', net_amount_minor: 100000, vat_amount_minor: 0,
    shipping_amount_minor: 0, total_amount_minor: 100000, deal_uuid: dealUuid, created_by_admin_id: adminId }).returning('id');
  const { eventId } = await require('../../src/services/quoteService')
    .convertToEvent(idOf(row), adminId, { hold: true, skipInvoices: true });
  return eventId;
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId } = await seedMinimal(db));
});
afterAll(async () => { if (cleanup) await cleanup(); });

describe('gallery contact copies', () => {
  test('erasure blanks the customer\'s details on their galleries and gallery mail finds no recipient', async () => {
    const erased = await customer();
    const eventId = await galleryFromQuote(erased.id);
    const before = await db('events').where({ id: eventId }).first();
    expect(before.customer_email).toBe(erased.email);
    expect(before.host_email).toBe(erased.email);

    await require('../../src/services/customerAccountsService').eraseCustomer(erased.id, adminId);

    const after = await db('events').where({ id: eventId }).first();
    expect({ customer_name: after.customer_name, customer_email: after.customer_email, customer_phone: after.customer_phone,
      host_name: after.host_name, host_email: after.host_email })
      .toEqual({ customer_name: null, customer_email: null, customer_phone: null, host_name: null, host_email: null });

    // A gallery of a customer who stays shows the expiry pass does queue mail.
    const kept = await customer();
    const keptEventId = await galleryFromQuote(kept.id);
    await db('events').whereIn('id', [eventId, keptEventId]).update({ is_draft: false, is_active: true,
      expires_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString() });
    await require('../../src/services/expirationChecker').checkExpirations();
    const queuedTo = address => db('email_queue').whereRaw('LOWER(recipient_email) = ?', [address]);
    expect(await queuedTo(kept.email)).toHaveLength(1);
    expect(await queuedTo(erased.email)).toHaveLength(0);
  });

  test('a host typed for someone else and another customer\'s gallery stay', async () => {
    const erased = await customer();
    const other = await customer();
    const own = await galleryFromQuote(erased.id);
    const foreign = await galleryFromQuote(other.id);
    await db('events').where({ id: own }).update({ host_name: 'Partner', host_email: 'partner@example.test' });

    await require('../../src/services/customerAccountsService').eraseCustomer(erased.id, adminId);

    const ownAfter = await db('events').where({ id: own }).first();
    expect(ownAfter.customer_email).toBeNull();
    expect(ownAfter.host_email).toBe('partner@example.test');
    expect(ownAfter.host_name).toBe('Partner');
    const foreignAfter = await db('events').where({ id: foreign }).first();
    expect(foreignAfter.customer_email).toBe(other.email);
    expect(foreignAfter.host_email).toBe(other.email);
  });
});
