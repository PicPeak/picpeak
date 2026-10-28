'use strict';

jest.mock('../../src/database/db', () => ({ db: jest.fn() }));
jest.mock('../../src/services/emailProcessor', () => ({
  initializeTransporter: jest.fn(), resolveFromIdentity: jest.fn(async () => ({ fromName: 'Studio', fromEmail: 'studio@example.test' })),
  wrapEmailHtml: jest.fn(async (html) => html), buildSignatureTextFor: jest.fn(async () => '\nStudio'),
}));
jest.mock('../../src/services/emailWebhookTransport', () => ({ isEnabled: jest.fn(() => false), send: jest.fn(async () => {}) }));
const mailer = require('../../src/services/emailProcessor');
const webhook = require('../../src/services/emailWebhookTransport');
const { sendCodeEmail } = require('../../src/modules/photoSales/promoIdentity');

describe('promo verification email transport', () => {
  beforeEach(() => { jest.clearAllMocks(); webhook.isEnabled.mockReturnValue(false); });
  test.each(['en', 'de'])('sends %s verification without putting the code in the subject', async (language) => {
    const sendMail = jest.fn(async () => {}); mailer.initializeTransporter.mockResolvedValue({ sendMail });
    await sendCodeEmail({ to: 'buyer@example.test', code: '012345', language });
    expect(sendMail).toHaveBeenCalledTimes(1);
    const [mail] = sendMail.mock.calls[0];
    expect(mail.subject).not.toContain('012345');
    expect(mail.text).toContain('012345'); expect(mail.html).toContain('012345');
    expect(mail.to).toBe('buyer@example.test'); expect(mail.text).toContain('Studio');
    expect(webhook.send).not.toHaveBeenCalled();
  });
  test('supports webhook-only installations without initializing SMTP', async () => {
    webhook.isEnabled.mockReturnValue(true);
    await sendCodeEmail({ to: 'buyer@example.test', code: '012345', language: 'en' });
    expect(webhook.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'buyer@example.test' }));
    expect(mailer.initializeTransporter).not.toHaveBeenCalled();
  });
  test('reports missing transport rather than claiming the code was sent', async () => {
    mailer.initializeTransporter.mockResolvedValue(null);
    await expect(sendCodeEmail({ to: 'buyer@example.test', code: '012345', language: 'en' })).rejects.toThrow('Email service unavailable');
  });
});
