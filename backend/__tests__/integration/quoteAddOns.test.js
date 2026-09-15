/**
 * Optional add-ons chosen on the public quote page (#1451 phase 2).
 *
 * Real public routes → quoteService → SQLite with the full core-migration run
 * (helpers/crmDb). Pins:
 *   - the public view lists add-ons with their selection;
 *   - live totals follow the choice, including a percentage promotion;
 *   - only offered add-ons can be chosen;
 *   - accepting refuses a total that doesn't match the server's, or none;
 *   - an accepted choice is stored with the recalculated totals and the
 *     accepted PDF, and is fixed from then on (the response window still
 *     toggles accept / decline);
 *   - an admin acceptance records the editor's choice;
 *   - a quote without add-ons accepts exactly as before.
 */

const request = require('supertest');
const {
  bootCrmDb, seedMinimal, createPublicToken, buildRouteApp,
} = require('./helpers/crmDb');
const { isTruthyFlag } = require('../../src/utils/lineItemTotals');

jest.setTimeout(120000);

let db;
let cleanup;
let tmpDir;
let adminId;
let customerId;
let app;
let quoteService;
let promotionId;

const prevCwd = process.cwd();

async function setFlag(key, value) {
  const updated = await db('feature_flags').where({ key }).update({ value });
  if (!updated) await db('feature_flags').insert({ key, value });
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  db.client.pool.acquireTimeoutMillis = 2000;
  ({ adminId, customerId } = await seedMinimal(db));
  await setFlag('quotes', true);
  quoteService = require('../../src/services/quoteService');
  app = buildRouteApp('/api/public/quotes', require('../../src/routes/publicQuotes'));

  const inserted = await db('quote_promotions').insert({
    name: 'Verein', type: 'percent', percent: 10, is_active: true,
    created_at: new Date(), updated_at: new Date(),
  }).returning('id');
  promotionId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

async function sentQuote(lineItems) {
  const quoteId = await quoteService.createQuote({
    customerAccountId: customerId, currency: 'CHF', vatRate: 8.1, lineItems,
  }, adminId);
  await db('quotes').where({ id: quoteId }).update({ status: 'sent', sent_at: new Date() });
  const token = await createPublicToken(db, 'quote_action_tokens', { quote_id: quoteId });
  return { quoteId, token };
}

// CHF 1000 wedding day; an album add-on (CHF 300, not ticked, with an unpriced
// sub-item); a drone add-on (CHF 200, ticked); −10 %; 8.1 % VAT.
//   default (drone):  1200 − 120 = 1080 net, 87.48 VAT → 1167.48
//   album only:      1300 − 130 = 1170 net, 94.77 VAT → 1264.77
//   album + drone:   1500 − 150 = 1350 net, 109.35 VAT → 1459.35
const withAddOns = () => sentQuote([
  { position: 1, quantity: 1, description: 'Wedding day', unit_price_minor: 100000 },
  { position: 2, quantity: 1, description: 'Album', unit_price_minor: 30000, is_optional: true, selected: false },
  { position: 3, quantity: 1, description: 'Album cover', unit_price_minor: 0, parent_position: 2 },
  { position: 4, quantity: 1, description: 'Drone', unit_price_minor: 20000, is_optional: true, selected: true },
  { position: 5, quantity: 1, description: 'Verein', unit_price_minor: 0, line_kind: 'discount', promotion_id: promotionId },
]);

const respond = (token, body) => request(app).post(`/api/public/quotes/${token}/respond`).send(body);

async function linesByDescription(quoteId) {
  const rows = await db('quote_line_items').where({ quote_id: quoteId });
  return (d) => rows.find((r) => r.description === d);
}

test('the public view lists add-ons with their selection', async () => {
  const { token } = await withAddOns();
  const res = await request(app).get(`/api/public/quotes/${token}`);
  expect(res.status).toBe(200);
  const line = (d) => res.body.quote.lineItems.find((li) => li.description === d);
  expect(line('Album')).toEqual(expect.objectContaining({ isOptional: true, selected: false }));
  expect(line('Album cover')).toEqual(expect.objectContaining({ isOptional: true, selected: false }));
  expect(line('Drone')).toEqual(expect.objectContaining({ isOptional: true, selected: true }));
  expect(line('Wedding day').isOptional).toBe(false);
  expect(res.body.quote.selectionLocked).toBe(false);
  expect(res.body.quote.totalAmountMinor).toBe(116748);
});

test('live totals follow the choice, the percentage promotion included', async () => {
  const { token } = await withAddOns();
  const res = await request(app).get(`/api/public/quotes/${token}/totals?selected=2,4`);
  expect(res.status).toBe(200);
  expect(res.body).toEqual(expect.objectContaining({
    selectedOptional: [2, 4], netAmountMinor: 135000, vatAmountMinor: 10935, totalAmountMinor: 145935,
  }));
  expect(res.body.lines.find((l) => l.position === 5).lineTotalMinor).toBe(-15000);
});

test('only offered add-ons can be chosen', async () => {
  const { token } = await withAddOns();
  const res = await request(app).get(`/api/public/quotes/${token}/totals?selected=1`);
  expect(res.status).toBe(400);
  expect(res.body.code).toBe('INVALID_SELECTION');
});

test('a manipulated total is refused and nothing is written', async () => {
  const { quoteId, token } = await withAddOns();
  const res = await respond(token, { action: 'accept', selectedOptional: [2, 4], expectedTotalMinor: 100 });
  expect(res.status).toBe(409);
  expect(res.body).toEqual(expect.objectContaining({ code: 'TOTAL_MISMATCH', totalAmountMinor: 145935 }));
  const quote = await db('quotes').where({ id: quoteId }).first();
  expect(quote.status).toBe('sent');
  expect(quote.selection_accepted_at).toBeNull();
});

test('accepting a quote with add-ons needs the total that was shown', async () => {
  const { token } = await withAddOns();
  const res = await respond(token, { action: 'accept', selectedOptional: [4] });
  expect(res.status).toBe(400);
  expect(res.body.code).toBe('TOTAL_REQUIRED');
});

test('accepting stores the choice, the recalculated totals and the accepted PDF', async () => {
  const { quoteId, token } = await withAddOns();
  const res = await respond(token, { action: 'accept', selectedOptional: [2], expectedTotalMinor: 126477 });
  expect(res.status).toBe(200);

  const quote = await db('quotes').where({ id: quoteId }).first();
  expect(quote.status).toBe('accepted');
  expect(Number(quote.net_amount_minor)).toBe(117000);
  expect(Number(quote.total_amount_minor)).toBe(126477);
  expect(quote.selection_accepted_at).toBeTruthy();
  expect(JSON.parse(quote.optional_selection_snapshot)).toEqual(expect.objectContaining({
    by: 'customer', selectedOptional: [2], totalAmountMinor: 126477,
  }));
  expect(quote.pdf_path).toMatch(/-accepted\.pdf$/);

  const line = await linesByDescription(quoteId);
  expect(isTruthyFlag(line('Album').selected)).toBe(true);
  expect(isTruthyFlag(line('Album cover').selected)).toBe(true);
  expect(isTruthyFlag(line('Drone').selected)).toBe(false);
  expect(Number(line('Verein').line_total_minor)).toBe(-13000);
});

test('the choice is fixed after the first acceptance', async () => {
  const { quoteId, token } = await withAddOns();
  expect((await respond(token, { action: 'accept', selectedOptional: [4], expectedTotalMinor: 116748 })).status).toBe(200);
  expect((await respond(token, { action: 'decline' })).status).toBe(200);

  const changed = await respond(token, { action: 'accept', selectedOptional: [2, 4], expectedTotalMinor: 145935 });
  expect(changed.status).toBe(409);
  expect(changed.body.code).toBe('SELECTION_LOCKED');

  // Accepting again inside the window keeps the first choice.
  expect((await respond(token, { action: 'accept', selectedOptional: [4] })).status).toBe(200);
  const quote = await db('quotes').where({ id: quoteId }).first();
  expect(quote.status).toBe('accepted');
  expect(JSON.parse(quote.optional_selection_snapshot).selectedOptional).toEqual([4]);

  const view = await request(app).get(`/api/public/quotes/${token}`);
  expect(view.body.quote.selectionLocked).toBe(true);
});

test('an admin acceptance records the choice set in the editor', async () => {
  const { quoteId } = await withAddOns();
  await quoteService.adminAcceptQuote(quoteId, adminId);
  const quote = await db('quotes').where({ id: quoteId }).first();
  expect(quote.status).toBe('accepted');
  expect(JSON.parse(quote.optional_selection_snapshot)).toEqual(expect.objectContaining({
    by: 'admin', selectedOptional: [4], totalAmountMinor: 116748,
  }));
});

test('a quote without add-ons accepts as before', async () => {
  const { quoteId, token } = await sentQuote([
    { position: 1, quantity: 1, description: 'Portrait session', unit_price_minor: 50000 },
  ]);
  expect((await respond(token, { action: 'accept' })).status).toBe(200);
  const quote = await db('quotes').where({ id: quoteId }).first();
  expect(quote.status).toBe('accepted');
  expect(quote.selection_accepted_at).toBeNull();
  expect(quote.optional_selection_snapshot).toBeNull();
});
