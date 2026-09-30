/**
 * markUsed version bounds (issue 1740).
 *
 * A signal whose meaning changed between catalogs is fed by two kinds of
 * evidence: the old kind (a webhook test/replay enqueue) must stop being
 * recorded once the install has consented to the new text, and the new kind
 * (a delivered webhook) must not be recorded under a consent that was given
 * to the old text. `until` and `since` are those two bounds; each consent
 * version sees exactly one of them.
 */
const { bootCrmDb } = require('../integration/helpers/crmDb');

let db, cleanup, service;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  service = require('../../src/services/productUsageService');
}, 30000);

afterAll(async () => {
  await cleanup();
});

beforeEach(async () => {
  await db('product_usage_markers').del();
});

const consent = (version) =>
  db('product_usage_state').where({ id: 1 }).update({ status: 'active', consent_version: version });
const markers = () => db('product_usage_markers').pluck('feature');

describe.each([
  ['usage-consent.v2', true, false],
  ['usage-consent.v5', true, false],
  ['usage-consent.v6', false, true],
])('under %s', (version, enqueueCounts, deliveryCounts) => {
  beforeEach(() => consent(version));

  test(`enqueue evidence (until usage.v6) ${enqueueCounts ? 'is' : 'is not'} recorded`, async () => {
    await service.markUsed(['webhooks'], { until: 'usage.v6' });
    expect(await markers()).toEqual(enqueueCounts ? ['webhooks'] : []);
  });

  test(`delivery evidence (since usage.v6) ${deliveryCounts ? 'is' : 'is not'} recorded`, async () => {
    await service.markUsed(['webhooks'], { since: 'usage.v6' });
    expect(await markers()).toEqual(deliveryCounts ? ['webhooks'] : []);
  });
});

test('an inactive install records nothing either way', async () => {
  await db('product_usage_state').where({ id: 1 }).update({ status: 'disabled', consent_version: 'usage-consent.v6' });
  await service.markUsed(['webhooks'], { since: 'usage.v6' });
  await service.markUsed(['webhooks'], { until: 'usage.v6' });
  expect(await markers()).toEqual([]);
});
