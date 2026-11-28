'use strict';

jest.mock('../../src/database/db', () => ({ db: jest.fn() }));
jest.mock('../../src/services/emailProcessor', () => ({
  initializeTransporter: jest.fn(), resolveFromIdentity: jest.fn(async () => ({ fromName: 'Studio', fromEmail: 'studio@example.test' })),
  wrapEmailHtml: jest.fn(async (html) => html), buildSignatureTextFor: jest.fn(async () => '\nStudio'),
}));
jest.mock('../../src/services/emailWebhookTransport', () => ({ isEnabled: jest.fn(() => false), send: jest.fn(async () => {}) }));
const mailer = require('../../src/services/emailProcessor');
const { sendCodeEmail } = require('../../src/services/publicDocumentVerificationService');

// The code mail for a contract or quote follows the document language (issue 2617).
describe('document verification code email language', () => {
  let sendMail;
  beforeEach(() => {
    jest.clearAllMocks();
    sendMail = jest.fn(async () => {});
    mailer.initializeTransporter.mockResolvedValue({ sendMail });
  });

  test('writes a Portuguese document in Portuguese and wraps it as pt', async () => {
    await sendCodeEmail({ to: 'c@example.test', code: '012345', kind: 'contract', documentNumber: 'K-1', issuerName: 'Studio', language: 'pt' });
    const [mail] = sendMail.mock.calls[0];
    expect(mail.subject).toBe('Código de verificação do seu contrato K-1');
    expect(mail.text).toContain('Seu código de verificação é 012345.');
    expect(mailer.wrapEmailHtml).toHaveBeenCalledWith(expect.any(String), mail.subject, 'pt');
  });

  test('falls back to English for a language without copy', async () => {
    await sendCodeEmail({ to: 'c@example.test', code: '012345', kind: 'quote', documentNumber: 'A-1', language: 'xx' });
    const [mail] = sendMail.mock.calls[0];
    expect(mail.subject).toBe('Verification code for your quote A-1');
    expect(mailer.wrapEmailHtml).toHaveBeenCalledWith(expect.any(String), mail.subject, 'en');
  });
});
