'use strict';

jest.mock('../../src/database/db', () => ({ db: jest.fn() }));
jest.mock('../../src/services/emailProcessor', () => ({
  initializeTransporter: jest.fn(),
  resolveFromIdentity: jest.fn(async () => ({ fromName: 'Studio', fromEmail: 'studio@example.test' })),
  wrapEmailHtml: jest.fn(async (html) => html),
  buildSignatureTextFor: jest.fn(async () => ''),
  getRecipientLanguage: jest.fn(),
}));
jest.mock('../../src/services/emailWebhookTransport', () => ({ isEnabled: jest.fn(() => false), send: jest.fn(async () => {}) }));
const mailer = require('../../src/services/emailProcessor');
const { sendRecoveryEmail } = require('../../src/services/guestRecoveryService');

// The guest recovery code mail used to be English only (issue 2617).
describe('guest recovery email language', () => {
  let sendMail;
  beforeEach(() => {
    jest.clearAllMocks();
    sendMail = jest.fn(async () => {});
    mailer.initializeTransporter.mockResolvedValue({ sendMail });
  });

  test('writes in the gallery language', async () => {
    mailer.getRecipientLanguage.mockResolvedValue('pt');
    await sendRecoveryEmail('guest@example.test', '123456', 'Casamento <Ana>', { eventId: 7 });
    expect(mailer.getRecipientLanguage).toHaveBeenCalledWith('guest@example.test', 7);
    const [mail] = sendMail.mock.calls[0];
    expect(mail.subject).toBe('Seu código de verificação: 123456');
    expect(mail.html).toContain('Que bom ver você de novo em Casamento &lt;Ana&gt;');
    expect(mail.text).toBe('Seu código de verificação é 123456. Ele expira em 15 minutos.');
    expect(mailer.wrapEmailHtml).toHaveBeenCalledWith(expect.any(String), mail.subject, 'pt');
  });

  test('names the gallery generically and falls back to English for other languages', async () => {
    mailer.getRecipientLanguage.mockResolvedValue('ru');
    await sendRecoveryEmail('guest@example.test', '123456', '');
    const [mail] = sendMail.mock.calls[0];
    expect(mail.subject).toBe('Your verification code: 123456');
    expect(mail.html).toContain('Welcome back to your gallery');
  });

  test('a gallery without a name still gets a grammatical German heading', async () => {
    mailer.getRecipientLanguage.mockResolvedValue('de');
    await sendRecoveryEmail('guest@example.test', '123456', '');
    const [mail] = sendMail.mock.calls[0];
    expect(mail.html).toContain('Willkommen zurück in Ihrer Galerie');
    expect(mail.html).not.toContain('bei Ihre Galerie');
    expect(mail.text).toBe('Ihr Bestätigungscode lautet 123456. Er ist 15 Minuten gültig.');
  });
});
