/**
 * The add-on process around a quote (#1451).
 *
 * Real public + admin routes → quoteService → SQLite with the full
 * core-migration run (helpers/crmDb). Pins:
 *   - the quote email says when there are add-ons to choose;
 *   - the PDF lists every add-on, marked booked or not in the total;
 *   - the customer's message is stored with the acceptance and reaches the
 *     business in the "quote accepted" notice with the booked add-ons;
 *   - the business can change the add-ons of an accepted quote until a
 *     contract, event or invoice exists: recorded, re-rendered, and the
 *     customer is emailed the updated quote;
 *   - a stored default email template is brought up to date, an edited one
 *     is left alone.
 */

const request = require('supertest');
const PDFKit = require('pdfkit');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, createPublicToken, buildRouteApp,
} = require('./helpers/crmDb');

// Stored paths are relative to the storage root (storedPath.js).
const { resolveStoredPath: onDisk } = require('../../src/utils/storedPath');
// Reads a stored timestamp in whatever shape the engine returns it.
const { toMillis } = require('../../src/utils/queueTimestamps');


// The public quote page now needs the grant issued after the emailed code
// (upstream #1465); the code step itself is covered in its own suite. The
// service is required lazily: at module load it would initialise the db
// module before bootCrmDb points it at the temp database.
async function quoteGrant(token) {
  const verification = require('../../src/services/publicDocumentVerificationService');
  const row = await db('quote_action_tokens').where({ token }).first();
  return verification.issueGrant('quote', row, token);
}

jest.setTimeout(120000);

// A json/text column, read the same way on both engines: PostgreSQL hands
// back an object, SQLite the text.
const parsed = (value) => (typeof value === 'string' ? JSON.parse(value) : value);

let db;
let cleanup;
let tmpDir;
let adminId;
let customerId;
let token;
let publicApp;
let adminApp;
let quoteService;

const prevCwd = process.cwd();
const auth = { get Authorization() { return `Bearer ${token}`; } };

async function setFlag(key, value) {
  const updated = await db('feature_flags').where({ key }).update({ value });
  if (!updated) await db('feature_flags').insert({ key, value });
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
}

async function lastMail(type, to) {
  const row = await db('email_queue').where({ email_type: type, recipient_email: to }).orderBy('id', 'desc').first();
  // PostgreSQL hands a json column back already parsed; SQLite hands text.
  if (!row) return null;
  return typeof row.email_data === 'string' ? JSON.parse(row.email_data) : row.email_data;
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  db.client.pool.acquireTimeoutMillis = 2000;
  ({ adminId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  await setFlag('quotes', true);
  const profile = await db('business_profile').where({ id: 1 }).first();
  if (profile) await db('business_profile').where({ id: 1 }).update({ email: 'studio@example.com', company_name: 'Studio Test' });
  else await db('business_profile').insert({ id: 1, email: 'studio@example.com', company_name: 'Studio Test' });
  quoteService = require('../../src/services/quoteService');
  publicApp = buildRouteApp('/api/public/quotes', require('../../src/routes/publicQuotes'));
  adminApp = buildRouteApp('/api/admin/quotes', require('../../src/routes/adminQuotes'));
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

// CHF 1000 wedding day; an album add-on (CHF 300, not booked); a drone
// add-on (CHF 200, booked); no VAT.
async function quoteWithAddOns() {
  const quoteId = await quoteService.createQuote({
    customerAccountId: customerId, currency: 'CHF', vatRate: 0, lineItems: [
      { position: 1, quantity: 1, description: 'Wedding day', unit_price_minor: 100000 },
      { position: 2, quantity: 1, description: 'Album', unit_price_minor: 30000, is_optional: true, selected: false },
      { position: 3, quantity: 1, description: 'Drone', unit_price_minor: 20000, is_optional: true, selected: true },
    ],
  }, adminId);
  return quoteId;
}

async function sentQuote() {
  const quoteId = await quoteWithAddOns();
  await db('quotes').where({ id: quoteId }).update({ status: 'sent', sent_at: new Date() });
  const link = await createPublicToken(db, 'quote_action_tokens', { quote_id: quoteId });
  return { quoteId, link };
}

test('the quote email says when there are add-ons to choose', async () => {
  const quoteId = await quoteWithAddOns();
  await quoteService.sendQuote(quoteId, adminId);
  const customer = await db('customer_accounts').where({ id: customerId }).first();
  expect(await lastMail('quote_sent', customer.email)).toEqual(expect.objectContaining({ has_add_ons: true }));
});

test('the PDF lists every add-on, marked booked or not in the total', async () => {
  const quoteId = await quoteWithAddOns();
  const texts = jest.spyOn(PDFKit.prototype, 'text');
  await quoteService.getQuotePdfBuffer(quoteId);
  const drawn = texts.mock.calls.map((c) => String(c[0]));
  texts.mockRestore();
  expect(drawn).toEqual(expect.arrayContaining(['Album', 'Drone']));
  expect(drawn.some((t) => t.includes('nicht gebucht') || t.includes('not booked'))).toBe(true);
  expect(drawn.some((t) => /gebucht$|booked$/.test(t) && !t.includes('nicht') && !t.includes('not'))).toBe(true);
});

test('the PDF preview of unsaved lines marks each add-on as the editor shows it', async () => {
  // Unsaved lines have no ids; the booked / not booked marks must still follow each line.
  const texts = jest.spyOn(PDFKit.prototype, 'text');
  const res = await request(adminApp).post('/api/admin/quotes/preview').set(auth).send({
    customerAccountId: customerId, currency: 'CHF', vatRate: 0, language: 'de',
    lineItems: [
      { position: 1, quantity: 1, description: 'Wedding day', unitPriceMinor: 100000 },
      { position: 2, quantity: 1, description: 'Drone', unitPriceMinor: 25000, isOptional: true, selected: true },
      { position: 3, quantity: 1, description: 'Photo book', unitPriceMinor: 39000, isOptional: true, selected: false },
    ],
  });
  const drawn = texts.mock.calls.map((c) => String(c[0]));
  texts.mockRestore();
  expect(res.status).toBe(200);
  const marks = drawn.filter((t) => /^(Zusatzleistung|Add-on) ·/.test(t));
  expect(marks).toEqual([
    expect.stringMatching(/^(Zusatzleistung · gebucht|Add-on · booked)$/),
    expect.stringMatching(/^(Zusatzleistung · nicht gebucht|Add-on · not booked)$/),
  ]);
  // The not-booked amount is in parentheses, outside the total.
  expect(drawn.some((t) => t.startsWith('(') && t.includes('390.00'))).toBe(true);
});

test('the customer\'s message comes with the acceptance and reaches the business', async () => {
  const { quoteId, link } = await sentQuote();
  const res = await request(publicApp).post(`/api/public/quotes/${link}/respond`).set('X-Document-Access', await quoteGrant(link)).send({
    action: 'accept', selectedOptional: [3], expectedTotalMinor: 120000, customerMessage: 'Kein Album, aber gerne <b>zwei</b> Drohnenflüge?',
  });
  expect(res.status).toBe(200);
  const quote = await db('quotes').where({ id: quoteId }).first();
  expect(quote.customer_message).toBe('Kein Album, aber gerne <b>zwei</b> Drohnenflüge?');

  const notice = await lastMail('quote_accepted_admin', 'studio@example.com');
  expect(notice).toEqual(expect.objectContaining({
    quote_number: quote.quote_number, booked_add_ons: 'Drone', customer_message: 'Kein Album, aber gerne <b>zwei</b> Drohnenflüge?',
  }));
  const view = await request(adminApp).get(`/api/admin/quotes/${quoteId}`).set(auth);
  expect(view.body.quote).toEqual(expect.objectContaining({ customerMessage: expect.stringContaining('Kein Album'), addOnsEditable: true }));
});

test('the business hears about an acceptance once, and again when the choice changes', async () => {
  const { quoteId, link } = await sentQuote();
  const grant = await quoteGrant(link);
  const respond = (body) => request(publicApp).post(`/api/public/quotes/${link}/respond`)
    .set('X-Document-Access', grant).set('X-Forwarded-For', `198.51.100.${quoteId % 250}`).send(body);
  const notices = async () => (await db('email_queue').where({ email_type: 'quote_accepted_admin' })).length;

  expect((await respond({ action: 'accept', selectedOptional: [3], expectedTotalMinor: 120000 })).status).toBe(200);
  const first = await notices();
  expect(first).toBeGreaterThan(0);

  // The same choice again, and a decline followed by the same acceptance:
  // nothing new to tell.
  expect((await respond({ action: 'accept', selectedOptional: [3], expectedTotalMinor: 120000 })).status).toBe(200);
  expect((await respond({ action: 'decline' })).status).toBe(200);
  expect((await respond({ action: 'accept', selectedOptional: [3], expectedTotalMinor: 120000 })).status).toBe(200);
  expect(await notices()).toBe(first);

  // A different choice is worth a notice.
  expect((await respond({ action: 'accept', selectedOptional: [2], expectedTotalMinor: 130000 })).status).toBe(200);
  expect(await notices()).toBe(first + 1);
  expect((await db('quotes').where({ id: quoteId }).first()).acceptance_notified_at).toBeTruthy();
});

test('the public quote page shows the customer\'s name, not the placeholder', async () => {
  // The row keeps the raw text; every surface that shows it resolves the
  // placeholders. The PDF and the portal did; the public page printed
  // "Hallo {{customer_name}}".
  const { quoteId, link } = await sentQuote();
  await db('customer_accounts').where({ id: customerId }).update({ display_name: 'Anna Muster' });
  await db('quotes').where({ id: quoteId }).update({
    intro_text: 'Hallo {{customer_name}}', outro_text: 'Bis bald, {{business_name}}',
  });

  const res = await request(publicApp).get(`/api/public/quotes/${link}`)
    .set('X-Document-Access', await quoteGrant(link));
  expect(res.status).toBe(200);
  expect(res.body.quote.introText).toBe('Hallo Anna Muster');
  expect(res.body.quote.outroText).toBe('Bis bald, Studio Test');
  expect(JSON.stringify(res.body)).not.toContain('{{');
});

test('a re-sent quote is a new offer: answerable, news again, fresh consent, and it converts', async () => {
  // Nothing of the previous answer may carry over. Each field left behind
  // broke the new offer in its own way: the response window made the
  // acceptance 423 for good, the workflow marker stopped `quote.accepted`
  // from firing again, and the consent stamp made the record claim the
  // customer had agreed to terms they were never shown.
  const setSetting = async (key, value) => {
    const updated = await db('app_settings').where({ setting_key: key }).update({ setting_value: value });
    if (!updated) await db('app_settings').insert({ setting_key: key, setting_value: value });
  };
  // In a finally, so a failure here can't leave the requirement on and take
  // the next tests down with it.
  await setSetting('crm_quotes_tos_required', JSON.stringify(true));
  await setSetting('crm_quotes_tos_text', JSON.stringify('Terms A'));
  try {
    const { quoteId, link } = await sentQuote();
    const notices = async () => (await db('email_queue').where({ email_type: 'quote_accepted_admin' })).length;
    const accept = async (tok) => request(publicApp).post(`/api/public/quotes/${tok}/respond`)
      .set('X-Document-Access', await quoteGrant(tok))
      .send({ action: 'accept', selectedOptional: [3], expectedTotalMinor: 120000, tosAccepted: true });

    expect((await accept(link)).status).toBe(200);
    const first = await notices();
    const firstAnswer = await db('quotes').where({ id: quoteId }).first();
    expect(firstAnswer.tos_text_snapshot).toBe('Terms A');

    // Declined, the terms changed, then sent again.
    await quoteService.adminDeclineQuote(quoteId, adminId, 'Kunde überlegt noch');
    await setSetting('crm_quotes_tos_text', JSON.stringify('Terms B'));
    await quoteService.sendQuote(quoteId, adminId);
    const resent = await db('quotes').where({ id: quoteId }).first();
    expect(resent.acceptance_notified_at).toBeNull();
    expect(resent.workflow_response_emitted_at).toBeNull();
    expect(resent.tos_accepted_at).toBeNull();
    expect(resent.tos_text_snapshot).toBeNull();

    const fresh = await db('quote_action_tokens').where({ quote_id: quoteId }).orderBy('id', 'desc').first();
    expect((await accept(fresh.token)).status).toBe(200);
    expect(await notices()).toBe(first + 1);
    const second = await db('quotes').where({ id: quoteId }).first();
    // The consent is this offer's, against the terms that were shown now.
    expect(second.tos_text_snapshot).toBe('Terms B');
    // Through toMillis on both sides: PostgreSQL hands back a Date, whose
    // String() stops at the second, and two acceptances can land inside one.
    expect(toMillis(second.tos_accepted_at)).not.toBe(toMillis(firstAnswer.tos_accepted_at));

    // …and the acceptance reaches the workflow engine: the sweep can claim it
    // again once the window locks.
    await db('quotes').where({ id: quoteId })
      .update({ response_locked_at: new Date(Date.now() - 60 * 1000).toISOString() });
    expect(await quoteService.finalizeQuoteResponses()).toBeGreaterThan(0);
    expect((await db('quotes').where({ id: quoteId }).first()).workflow_response_emitted_at).toBeTruthy();
  } finally {
    // The terms requirement is this test's; the rest of the suite answers
    // without ticking a box.
    await setSetting('crm_quotes_tos_required', JSON.stringify(false));
    await setSetting('crm_quotes_tos_text', JSON.stringify(''));
  }
});

test('two add-on changes at once each record what they changed', async () => {
  // The "before" of the second change is what the first one left, not what
  // both of them read before either wrote.
  const { quoteId, link } = await sentQuote();
  await request(publicApp).post(`/api/public/quotes/${link}/respond`).set('X-Document-Access', await quoteGrant(link))
    .send({ action: 'accept', selectedOptional: [3], expectedTotalMinor: 120000 });

  const change = (selectedOptional) => request(adminApp).post(`/api/admin/quotes/${quoteId}/add-ons`)
    .set(auth).send({ selectedOptional });
  const results = await Promise.allSettled([change([2]), change([2, 3])]);
  expect(results.filter((r) => r.status === 'fulfilled' && r.value.status === 200).length).toBeGreaterThan(0);

  const history = parsed((await db('quotes').where({ id: quoteId }).first()).selection_changes);
  expect(history.length).toBeGreaterThan(0);
  // Every entry starts where the one before it ended.
  let previous = 120000;
  for (const entry of history) {
    expect(entry.totalBeforeMinor).toBe(previous);
    previous = entry.totalAfterMinor;
  }
  expect(Number((await db('quotes').where({ id: quoteId }).first()).total_amount_minor)).toBe(previous);
});

test('the business changes the add-ons of an accepted quote: recorded, re-rendered, emailed', async () => {
  const { quoteId, link } = await sentQuote();
  await request(publicApp).post(`/api/public/quotes/${link}/respond`).set('X-Document-Access', await quoteGrant(link)).send({ action: 'accept', selectedOptional: [3], expectedTotalMinor: 120000 });
  const before = await db('quotes').where({ id: quoteId }).first();

  const res = await request(adminApp).post(`/api/admin/quotes/${quoteId}/add-ons`).set(auth).send({ selectedOptional: [2] });
  expect(res.status).toBe(200);
  expect(res.body).toEqual(expect.objectContaining({ changed: true, totalAmountMinor: 130000 }));
  expect(res.body.quote.selectionChanges).toEqual([expect.objectContaining({
    by: 'admin', adminId, booked: ['Album'], removed: ['Drone'], totalBeforeMinor: 120000, totalAfterMinor: 130000,
  })]);

  const quote = await db('quotes').where({ id: quoteId }).first();
  expect(Number(quote.total_amount_minor)).toBe(130000);
  // First chosen by the customer, then changed by the business.
  expect(parsed(quote.optional_selection_snapshot)).toEqual(expect.objectContaining({ by: 'customer', selectedOptional: [2] }));
  expect(String(quote.selection_accepted_at)).toBe(String(before.selection_accepted_at));
  // Each version keeps its own file: the first acceptance stays on disk.
  expect(before.pdf_path).toMatch(/-accepted\.pdf$/);
  expect(quote.pdf_path).toMatch(/-accepted-2\.pdf$/);
  expect(require('fs').existsSync(onDisk(before.pdf_path))).toBe(true);

  const customer = await db('customer_accounts').where({ id: customerId }).first();
  const mail = await lastMail('quote_addons_updated', customer.email);
  expect(mail).toEqual(expect.objectContaining({ booked_list: 'Album', removed_list: 'Drone' }));
  expect(mail.attachments[0].contentPath).toBe(onDisk(quote.pdf_path));

  // The same choice again changes nothing and sends nothing.
  const count = (await db('email_queue').where({ email_type: 'quote_addons_updated' })).length;
  const same = await request(adminApp).post(`/api/admin/quotes/${quoteId}/add-ons`).set(auth).send({ selectedOptional: [2] });
  expect(same.body.changed).toBe(false);
  expect((await db('email_queue').where({ email_type: 'quote_addons_updated' })).length).toBe(count);
});

test('add-ons can only be changed on an accepted quote without a contract, event or invoice', async () => {
  const { quoteId, link } = await sentQuote();
  const early = await request(adminApp).post(`/api/admin/quotes/${quoteId}/add-ons`).set(auth).send({ selectedOptional: [2] });
  expect(early.status).toBe(409);
  expect(early.body.code).toBe('QUOTE_NOT_ACCEPTED');

  await request(publicApp).post(`/api/public/quotes/${link}/respond`).set('X-Document-Access', await quoteGrant(link)).send({ action: 'accept', selectedOptional: [3], expectedTotalMinor: 120000 });
  // An invoice made from the quote, rather than a fake foreign key a real
  // database would refuse.
  await db('invoices').insert({
    invoice_number: `I-ADDON-${quoteId}`, customer_account_id: customerId, status: 'sent',
    issue_date: '2026-09-01', due_date: '2026-09-15', source_quote_id: quoteId,
  });
  const late = await request(adminApp).post(`/api/admin/quotes/${quoteId}/add-ons`).set(auth).send({ selectedOptional: [2] });
  expect(late.status).toBe(409);
  expect(late.body.code).toBe('QUOTE_CONVERTED');
  const view = await request(adminApp).get(`/api/admin/quotes/${quoteId}`).set(auth);
  expect(view.body.quote.addOnsEditable).toBe(false);
});

test('saving a quote books and removes its add-ons, right after a restart too', async () => {
  // After a restart the column checks are uncached; run inside the save
  // transaction they waited on the one SQLite connection and failed the save.
  const quoteId = await quoteWithAddOns();
  require('../../src/utils/schemaCache').invalidateSchemaCache();
  const res = await request(adminApp).put(`/api/admin/quotes/${quoteId}`).set(auth).send({
    projectId: null, eventType: 'wedding', vatRate: 0,
    lineItems: [
      { position: 1, quantity: 1, description: 'Wedding day', unitPriceMinor: 100000 },
      { position: 2, quantity: 1, description: 'Album', unitPriceMinor: 30000, isOptional: true, selected: true },
      { position: 3, quantity: 1, description: 'Drone', unitPriceMinor: 20000, isOptional: true, selected: false },
    ],
  });
  expect(res.status).toBe(200);
  const { isTruthyFlag } = require('../../src/utils/lineItemTotals');
  const rows = await db('quote_line_items').where({ quote_id: quoteId });
  const line = (d) => rows.find((r) => r.description === d);
  expect(isTruthyFlag(line('Album').selected)).toBe(true);
  expect(isTruthyFlag(line('Drone').selected)).toBe(false);
  const quote = await db('quotes').where({ id: quoteId }).first();
  expect(Number(quote.total_amount_minor)).toBe(130000);
});

test('a save that clears the intro, closing, notes and event name clears them', async () => {
  // The editor sends a cleared field as null; left out, the old text came back.
  const quoteId = await quoteService.createQuote({
    customerAccountId: customerId, currency: 'CHF', vatRate: 0,
    introText: 'Hallo', outroText: 'Freundliche Grüsse', internalNotes: 'intern', eventName: 'Hochzeit',
    lineItems: [{ position: 1, quantity: 1, description: 'Wedding day', unit_price_minor: 100000 }],
  }, adminId);
  const res = await request(adminApp).put(`/api/admin/quotes/${quoteId}`).set(auth).send({
    introText: null, outroText: null, internalNotes: null, eventName: null,
    lineItems: [{ position: 1, quantity: 1, description: 'Wedding day', unitPriceMinor: 100000 }],
  });
  expect(res.status).toBe(200);
  const quote = await db('quotes').where({ id: quoteId }).first();
  expect(quote).toEqual(expect.objectContaining({
    intro_text: null, outro_text: null, internal_notes: null, event_name: null,
  }));
});

test('a default email template is brought up to date; an edited one is left alone', async () => {
  const templates = require('../../src/services/crmEmailTemplates');
  const row = await db('email_templates').where({ template_key: 'quote_sent' }).first();
  const translations = await db.schema.hasTable('email_template_translations');
  if (!row || !translations) return; // nothing stored to upgrade on this schema
  const old = templates.PREVIOUS_DEFAULTS.quote_sent;
  await db('email_template_translations').where({ template_id: row.id, language: 'en' })
    .update({ subject: old.en.subject, body_html: old.en.body_html, body_text: old.en.body_text });
  await db('email_template_translations').where({ template_id: row.id, language: 'de' })
    .update({ subject: old.de.subject, body_html: `${old.de.body_html}<p>Eigener Text</p>`, body_text: old.de.body_text });

  await new Promise((resolve, reject) => {
    jest.isolateModules(() => {
      require('../../src/services/crmEmailTemplates').ensureCrmEmailTemplatesSeeded(db, null).then(resolve, reject);
    });
  });
  const en = await db('email_template_translations').where({ template_id: row.id, language: 'en' }).first();
  const de = await db('email_template_translations').where({ template_id: row.id, language: 'de' }).first();
  expect(en.body_html).toContain('{{#if has_add_ons}}');
  expect(de.body_html).toContain('Eigener Text');
  expect(de.body_html).not.toContain('{{#if has_add_ons}}');
});
