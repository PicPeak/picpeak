/**
 * Webhook email transport (#1225).
 *
 * Pins the four things the issue said had to be decided before this could
 * ship, because each is a security or data-loss property rather than a
 * preference:
 *
 *  - it will not run unsigned (URL without a secret stays OFF)
 *  - the body is HMAC-signed with the same scheme as gallery webhooks
 *  - the URL goes through the DNS-resolving SSRF check
 *  - attachments are carried, and an oversized one FAILS rather than being
 *    dropped — an invoice email arriving without its invoice is worse than
 *    one that errors and stays in the queue
 */

jest.mock('axios', () => ({ post: jest.fn() }));
jest.mock('../../src/utils/networkValidation', () => ({
  validateExternalUrlAsync: jest.fn(async () => ({ valid: true, reason: 'ok' })),
}));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const path = require('path');
const os = require('os');
const fsSync = require('fs');

const axios = require('axios');
const { validateExternalUrlAsync } = require('../../src/utils/networkValidation');
const logger = require('../../src/utils/logger');
const transport = require('../../src/services/emailWebhookTransport');
const { verifySignature } = require('../../src/services/webhookService');

const URL = 'https://n8n.example.com/webhook/picpeak-mail';
const SECRET = 'a-long-random-shared-secret';

const MAIL = {
  from: 'PicPeak <noreply@example.com>',
  to: 'client@example.com',
  subject: 'Your gallery is ready',
  html: '<p>hello</p>',
  text: 'hello',
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.EMAIL_WEBHOOK_URL = URL;
  process.env.EMAIL_WEBHOOK_SECRET = SECRET;
  transport.__testing.setAllowPrivateUrls(false);
  transport.__testing.resetSecretWarning();
  validateExternalUrlAsync.mockResolvedValue({ valid: true, reason: 'ok' });
  axios.post.mockResolvedValue({ status: 200, data: {} });
});

afterEach(() => {
  delete process.env.EMAIL_WEBHOOK_URL;
  delete process.env.EMAIL_WEBHOOK_SECRET;
});

describe('enablement', () => {
  it('is off when no URL is configured', () => {
    delete process.env.EMAIL_WEBHOOK_URL;
    expect(transport.isEnabled()).toBe(false);
  });

  it('is ON with a URL and a secret', () => {
    expect(transport.isEnabled()).toBe(true);
  });

  it('refuses to run unsigned: a URL without a secret stays OFF and says why', () => {
    delete process.env.EMAIL_WEBHOOK_SECRET;
    expect(transport.isEnabled()).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('EMAIL_WEBHOOK_SECRET'));
  });

  it('logs that misconfiguration once, not per email', () => {
    delete process.env.EMAIL_WEBHOOK_SECRET;
    transport.isEnabled();
    transport.isEnabled();
    transport.isEnabled();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

describe('signing', () => {
  it('signs the exact bytes sent, verifiable with the shared secret', async () => {
    await transport.send(MAIL);

    const [url, body, opts] = axios.post.mock.calls[0];
    expect(url).toBe(URL);
    const signature = opts.headers[transport.__testing.SIGNATURE_HEADER];
    // Same verifier a receiver would use for gallery webhooks.
    expect(verifySignature(SECRET, body, signature)).toBe(true);
    // And it must not verify against the wrong secret.
    expect(verifySignature('not-the-secret', body, signature)).toBe(false);
  });

  it('sends the composed message, with recipients normalised to lists', async () => {
    await transport.send({ ...MAIL, cc: 'a@example.com, b@example.com' });
    const payload = JSON.parse(axios.post.mock.calls[0][1]);
    expect(payload.to).toEqual(['client@example.com']);
    expect(payload.cc).toEqual(['a@example.com', 'b@example.com']);
    expect(payload.subject).toBe('Your gallery is ready');
    expect(payload.html).toBe('<p>hello</p>');
  });

  it('splits a combined address that arrives INSIDE an array', async () => {
    // sendRawEmail wraps a string cc in an array before it reaches here, so
    // "a@x, b@y" lands as one element. Left unsplit, the payload carries one
    // combined address that a relay treating each element as a mailbox rejects.
    await transport.send({ ...MAIL, cc: ['a@example.com, b@example.com'] });
    const payload = JSON.parse(axios.post.mock.calls[0][1]);
    expect(payload.cc).toEqual(['a@example.com', 'b@example.com']);
  });
});

describe('SSRF preflight', () => {
  it('refuses a URL that resolves to a private address', async () => {
    validateExternalUrlAsync.mockResolvedValue({
      valid: false, error: 'URL points to a private or internal network address', reason: 'private',
    });
    await expect(transport.send(MAIL)).rejects.toThrow(/rejected/);
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('allows a private receiver only when explicitly opted in', async () => {
    validateExternalUrlAsync.mockResolvedValue({ valid: false, error: 'private', reason: 'private' });
    transport.__testing.setAllowPrivateUrls(true);
    await expect(transport.send(MAIL)).resolves.toBeTruthy();
    // The check is skipped entirely rather than its answer ignored.
    expect(validateExternalUrlAsync).not.toHaveBeenCalled();
  });
});

describe('attachments', () => {
  const tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'picpeak-webhook-mail-'));
  const filePath = path.join(tmpDir, 'invoice.pdf');
  fsSync.writeFileSync(filePath, 'PDFBYTES');

  it('carries a file from disk as base64 rather than dropping it', async () => {
    await transport.send({
      ...MAIL,
      attachments: [{ filename: 'invoice.pdf', path: filePath, contentType: 'application/pdf' }],
    });
    const payload = JSON.parse(axios.post.mock.calls[0][1]);
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments[0].filename).toBe('invoice.pdf');
    expect(payload.attachments[0].content_type).toBe('application/pdf');
    expect(Buffer.from(payload.attachments[0].content_base64, 'base64').toString()).toBe('PDFBYTES');
  });

  it('carries an in-memory buffer too', async () => {
    await transport.send({
      ...MAIL,
      attachments: [{ filename: 'note.txt', content: Buffer.from('hi') }],
    });
    const payload = JSON.parse(axios.post.mock.calls[0][1]);
    expect(Buffer.from(payload.attachments[0].content_base64, 'base64').toString()).toBe('hi');
  });

  it('FAILS on an oversized attachment instead of sending the mail without it', async () => {
    const huge = Buffer.alloc(transport.__testing.MAX_ATTACHMENT_BYTES + 1);
    await expect(transport.send({
      ...MAIL,
      attachments: [{ filename: 'huge.bin', content: huge }],
    })).rejects.toThrow(/exceed/);
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('rejects an oversized FILE by its size, without reading it into memory', async () => {
    // The cap has to be checked from stat, not after readFile — otherwise a
    // file big enough to exhaust memory kills the process before the guard
    // that exists to stop it ever fires.
    const bigPath = path.join(tmpDir, 'big.bin');
    fsSync.writeFileSync(bigPath, Buffer.alloc(1024));
    const statSpy = jest.spyOn(require('fs').promises, 'stat')
      .mockResolvedValue({ size: transport.__testing.MAX_ATTACHMENT_BYTES + 1 });
    const readSpy = jest.spyOn(require('fs').promises, 'readFile');

    await expect(transport.send({
      ...MAIL,
      attachments: [{ filename: 'big.bin', path: bigPath }],
    })).rejects.toThrow(/exceed/);
    expect(readSpy).not.toHaveBeenCalled();

    statSpy.mockRestore();
    readSpy.mockRestore();
  });
});

describe('response handling', () => {
  it('caps how much of a receiver response it will buffer', async () => {
    await transport.send(MAIL);
    const opts = axios.post.mock.calls[0][2];
    // Only the status and an optional messageId are read; an unbounded body
    // from a faulty or hostile receiver must not be buffered into memory.
    expect(opts.maxContentLength).toBeLessThanOrEqual(10 * 1024);
    expect(opts.maxBodyLength).toEqual(expect.any(Number));
  });
});

describe('delivery result', () => {
  it('treats a non-2xx as a failure so the queue retries', async () => {
    axios.post.mockResolvedValue({ status: 502, data: {} });
    await expect(transport.send(MAIL)).rejects.toThrow(/502/);
  });

  it('returns a messageId so the queue can record the send', async () => {
    const result = await transport.send(MAIL);
    expect(result.messageId).toEqual(expect.any(String));
    expect(result.messageId.length).toBeGreaterThan(0);
  });

  it('prefers a messageId the receiver reports', async () => {
    axios.post.mockResolvedValue({ status: 200, data: { messageId: 'from-n8n-123' } });
    expect((await transport.send(MAIL)).messageId).toBe('from-n8n-123');
  });
});
