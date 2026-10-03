/**
 * The expiry checker and the assignment email judge events.expires_at by
 * value on SQLite, whatever shape it was stored in (issue 1733).
 *
 * Event creation writes ISO text, the extend endpoint writes a Date (epoch ms
 * on SQLite), the edit form sends any ISO-8601. Comparing the column against
 * a bound Date matched only the epoch-ms rows: a gallery created through the
 * normal path never got its warning, never expired, never archived, and the
 * assignment email listed it after it had expired.
 *
 * Side effects of a pass (archive, workflow engine, mail, webhooks) are
 * stubbed; the assertions are on which rows each query selected.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-expiry-shapes-'));
process.env.STORAGE_PATH = tmp;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-that-is-long-enough-for-validation';

const mockQueueEmail = jest.fn(async () => {});
const mockEmitWorkflowEvent = jest.fn(async () => {});
const mockArchiveEvent = jest.fn(async () => {});

jest.mock('../../src/services/emailProcessor', () => ({
  queueEmail: (...args) => mockQueueEmail(...args),
  getSupportEmail: async () => 'support@example.com',
}));
jest.mock('../../src/services/workflows', () => ({
  isBuiltinFlowActive: async () => false,
  emitWorkflowEvent: (...args) => mockEmitWorkflowEvent(...args),
}));
jest.mock('../../src/services/archiveService', () => ({
  archiveEvent: (...args) => mockArchiveEvent(...args),
}));
jest.mock('../../src/services/shareLinkService', () => ({
  buildShareLinkVariants: async ({ slug }) => ({ shareUrl: `https://example.test/gallery/${slug}` }),
}));
jest.mock('../../src/services/webhookService', () => ({
  fire: async () => {},
  buildEventSubject: (e) => e,
}));
jest.mock('../../src/utils/frontendUrl', () => ({
  getFrontendBaseUrl: async () => 'https://example.test',
}));

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const naive = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

// One row per stored shape: expired a day ago, inside the 7-day warning
// window, and far in the future. Plain numbers and strings only: a Date
// written from inside jest lands as "[object Object]" (CLAUDE.md).
const FIXTURES = [
  ['iso-expired', new Date(now - DAY).toISOString()],
  ['iso-warning', new Date(now + 3 * DAY).toISOString()],
  ['iso-future', new Date(now + 30 * DAY).toISOString()],
  ['ms-expired', now - DAY],
  ['ms-warning', now + 3 * DAY],
  ['ms-future', now + 30 * DAY],
  ['naive-expired', naive(now - DAY)],
  ['naive-warning', naive(now + 3 * DAY)],
  ['naive-future', naive(now + 30 * DAY)],
  ['never', null],
];
const EXPIRED = ['iso-expired', 'ms-expired', 'naive-expired'];
const WARNING = ['iso-warning', 'ms-warning', 'naive-warning'];

describe('expires_at comparisons on SQLite', () => {
  let db; let cleanup; let customerId;
  const idBySlug = {};

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ customerId } = await seedMinimal(db));
    for (const [slug, expires_at] of FIXTURES) {
      const [inserted] = await db('events').insert({
        slug, event_type: 'wedding', event_name: slug, event_date: '2026-09-01',
        host_email: 'host@example.com', admin_email: 'admin@example.com',
        customer_email: 'customer@example.com',
        password_hash: 'unused', require_password: false,
        share_link: `/gallery/${slug}/share`, share_token: `${slug}-share`,
        expires_at, is_active: 1, is_archived: 0, is_draft: 0,
        created_at: new Date(now - 60 * DAY).toISOString(),
      }).returning('id');
      idBySlug[slug] = inserted?.id ?? inserted;
    }
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('the fixtures really hold the three shapes', async () => {
    const types = Object.fromEntries((await db('events').select('slug', db.raw('typeof(expires_at) as t')))
      .map((r) => [r.slug, r.t]));
    expect(types['iso-expired']).toBe('text');
    expect(types['ms-expired']).toBe('integer');
    expect(types['naive-expired']).toBe('text');
    expect(types.never).toBe('null');
  });

  test('the assignment email drops exactly the expired galleries', async () => {
    const { notifyCustomerOfNewAssignments } = require('../../src/services/customerAccountsService');
    await notifyCustomerOfNewAssignments(customerId, Object.values(idBySlug));

    expect(mockQueueEmail).toHaveBeenCalledTimes(1);
    const [, , type, vars] = mockQueueEmail.mock.calls[0];
    expect(type).toBe('customer_gallery_assigned');
    const listed = vars.gallery_list_text.split('\n').map((line) => line.replace(/^- /, '').replace(/ \(.*$/, ''));
    expect(listed.sort()).toEqual(
      FIXTURES.map(([slug]) => slug).filter((slug) => !EXPIRED.includes(slug)).sort(),
    );
    mockQueueEmail.mockClear();
  });

  test('one checker pass warns exactly the window rows and expires exactly the past ones', async () => {
    const { checkExpirations } = require('../../src/services/expirationChecker');
    await checkExpirations();

    const emitted = (type) => mockEmitWorkflowEvent.mock.calls
      .filter(([t]) => t === type).map(([, { payload }]) => payload.slug).sort();
    expect(emitted('gallery.expiring')).toEqual([...WARNING].sort());
    expect(emitted('gallery.expired')).toEqual([...EXPIRED].sort());

    expect(mockArchiveEvent.mock.calls.map(([e]) => e.slug).sort()).toEqual([...EXPIRED].sort());

    const queued = (type) => mockQueueEmail.mock.calls.filter(([, , t]) => t === type);
    expect(queued('expiration_warning').map(([id]) => id).sort()).toEqual(WARNING.map((s) => idBySlug[s]).sort());
    // Customer + admin for each expired gallery.
    expect(queued('gallery_expired')).toHaveLength(EXPIRED.length * 2);

    const inactive = (await db('events').where('is_active', 0).select('slug')).map((r) => r.slug).sort();
    expect(inactive).toEqual([...EXPIRED].sort());
  });
});
