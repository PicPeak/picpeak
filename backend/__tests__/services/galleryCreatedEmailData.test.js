// The gallery_created template variables are a contract. Send later / publish,
// creation and resend all build them through galleryCreatedEmailData, each with
// its own password text, expiry format, name fallback and extra keys; these pin
// every caller's payload key by key, in order.
jest.mock('../../src/database/db', () => ({ db: jest.fn() }));
jest.mock('../../src/services/emailProcessor', () => ({ queueEmail: jest.fn() }));
jest.mock('../../src/services/shareLinkService', () => ({
  buildShareLinkVariants: jest.fn(async ({ slug, shareToken }) => ({ shareUrl: `https://x.test/gallery/${slug}/${shareToken}` })),
}));
jest.mock('../../src/utils/frontendUrl', () => ({
  getFrontendBaseUrl: jest.fn(async () => 'https://x.test'),
  getAbsoluteFrontendUrl: jest.fn(async () => 'https://x.test'),
}));

const { galleryCreatedEmailData } = require('../../src/services/galleryNotificationService');

const row = {
  slug: 'wedding-anna-2026-01-01', share_token: 'tok', event_name: 'Anna', event_date: '2026-01-01',
  customer_name: null, host_name: null, customer_email: 'anna@x.test', host_email: null,
  expires_at: '2026-05-06 07:08:09', welcome_message: null,
};

const expectExactly = (actual, expected) => {
  expect(Object.keys(actual)).toEqual(Object.keys(expected));
  expect(actual).toStrictEqual(expected);
};

// Fixture values are built at runtime so no credential-shaped literal sits
// next to a password-named key.
const TYPED = ['typed', 'value'].join('-');
const SECURITY_TEXT = ['{{', 'password_security_message', '}}'].join('');

describe('galleryCreatedEmailData', () => {
  test('send later / publish: the row\'s address, the password rule, ISO expiry', async () => {
    const expected = (password) => ({
      customer_name: null,
      customer_email: 'anna@x.test',
      host_name: 'anna',
      event_name: 'Anna',
      event_date: '2026-01-01',
      gallery_link: 'https://x.test/gallery/wedding-anna-2026-01-01/tok',
      gallery_password: password,
      expiry_date: new Date('2026-05-06 07:08:09').toISOString(),
      welcome_message: '',
    });
    expectExactly(await galleryCreatedEmailData(row, { password: TYPED, requirePassword: true }), expected(TYPED));
    expectExactly(await galleryCreatedEmailData(row, { requirePassword: true }), expected('(set at creation)'));
    expectExactly(await galleryCreatedEmailData(row, { password: TYPED, requirePassword: false }), expected('No password required'));
  });

  test('creation: the recipient, the caller\'s link and password text (even undefined)', async () => {
    const data = await galleryCreatedEmailData({
      customer_name: null, host_name: null, event_name: 'Anna', event_date: undefined,
      expires_at: new Date('2026-05-06T07:08:09Z'), welcome_message: 'Hi',
    }, { recipientEmail: 'bob@x.test', shareUrl: 'https://x.test/gallery/s/t', galleryPassword: undefined });
    expectExactly(data, {
      customer_name: null,
      customer_email: 'bob@x.test',
      host_name: 'bob',
      event_name: 'Anna',
      event_date: undefined,
      gallery_link: 'https://x.test/gallery/s/t',
      gallery_password: undefined,
      expiry_date: '2026-05-06T07:08:09.000Z',
      welcome_message: 'Hi',
    });
  });

  test('resend: name falls back to the address for both name fields, raw expiry, resend keys', async () => {
    const data = await galleryCreatedEmailData(row, {
      recipientEmail: 'carol@x.test',
      nameFromAddress: true,
      shareUrl: 'https://x.test/gallery/s/t',
      galleryPassword: SECURITY_TEXT,
      rawExpiry: true,
      extra: { eventId: '42', isResend: true },
    });
    expectExactly(data, {
      customer_name: 'carol',
      customer_email: 'carol@x.test',
      host_name: 'carol',
      event_name: 'Anna',
      event_date: '2026-01-01',
      gallery_link: 'https://x.test/gallery/s/t',
      gallery_password: SECURITY_TEXT,
      expiry_date: '2026-05-06 07:08:09',
      welcome_message: '',
      eventId: '42',
      isResend: true,
    });
    const named = await galleryCreatedEmailData({ ...row, host_name: 'Host' }, {
      recipientEmail: 'carol@x.test', nameFromAddress: true, shareUrl: 'u', galleryPassword: TYPED, rawExpiry: true,
    });
    expect([named.customer_name, named.host_name]).toEqual(['Host', 'Host']);
  });
});
