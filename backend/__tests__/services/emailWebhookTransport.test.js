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
  transport.__testing.setReadTimeout(10000);
  validateExternalUrlAsync.mockResolvedValue({ valid: true, reason: 'ok' });
  axios.post.mockResolvedValue({ status: 200, data: streamOf('') });
});

// The transport reads the response as a stream, so mocks must behave like one.
function streamOf(text) {
  const { Readable } = require('stream');
  return Readable.from([Buffer.from(text, 'utf8')]);
}

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

describe('transport security', () => {
  it('refuses plaintext http:// — the HMAC signs, it does not conceal', async () => {
    // These bodies carry password-reset links and guest recovery codes, which
    // are usable by anyone on the path.
    process.env.EMAIL_WEBHOOK_URL = 'http://n8n.example.com/webhook/picpeak-mail';
    await expect(transport.send(MAIL)).rejects.toThrow(/https/);
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('allows http only under the private-network opt-in', async () => {
    process.env.EMAIL_WEBHOOK_URL = 'http://n8n.internal:5678/webhook/mail';
    transport.__testing.setAllowPrivateUrls(true);
    await expect(transport.send(MAIL)).resolves.toBeTruthy();
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
    expect(opts.responseType).toBe('stream');
    expect(opts.maxBodyLength).toEqual(expect.any(Number));
  });

  it('sizes the request cap in UTF-8 bytes, so non-ASCII mail is not rejected', async () => {
    // axios enforces maxBodyLength against the UTF-8 buffer it sends. Sizing it
    // from String#length counts UTF-16 code units, so a German or Japanese
    // message would exceed its own budget and never leave the process.
    await transport.send({ ...MAIL, subject: 'Grüße', html: '<p>これはテストです。ありがとう。</p>' });
    const [, body, opts] = axios.post.mock.calls[0];
    expect(opts.maxBodyLength).toBeGreaterThanOrEqual(Buffer.byteLength(body, 'utf8'));
    // And the gap is real: bytes genuinely exceed code units for this payload.
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(body.length);
  });
});

describe('delivery result', () => {
  it('treats a non-2xx as a failure so the queue retries', async () => {
    axios.post.mockResolvedValue({ status: 502, data: streamOf('') });
    await expect(transport.send(MAIL)).rejects.toThrow(/502/);
  });

  it('returns a messageId so the queue can record the send', async () => {
    const result = await transport.send(MAIL);
    expect(result.messageId).toEqual(expect.any(String));
    expect(result.messageId.length).toBeGreaterThan(0);
  });

  it('does NOT retry a delivered message just because the response was huge', async () => {
    // A receiver that delivered the mail and then echoed a large body must not
    // turn into a failure — the queue would resend and the recipient would get
    // the same email twice. The status is the verdict; the body is optional.
    const { Readable } = require('stream');
    const flood = Readable.from(
      Array.from({ length: 40 }, () => Buffer.alloc(1024, 0x61))
    );
    axios.post.mockResolvedValue({ status: 200, data: flood });
    const result = await transport.send(MAIL);
    expect(result.messageId).toEqual(expect.any(String));
  });

  it('never lets the request body escape inside a network error', async () => {
    // An AxiosError carries config.data — the whole serialised message, base64
    // attachments included — and config.headers holds the signature. Callers
    // log the error object and winston serialises it, so propagating the raw
    // error writes password-reset links and invoices into combined.log.
    const axiosError = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
      config: {
        data: JSON.stringify({ html: 'RESET-LINK-SECRET' }),
        headers: { 'X-PicPeak-Signature': 'the-signature' },
      },
    });
    axios.post.mockRejectedValue(axiosError);

    const caught = await transport.send(MAIL).catch((e) => e);
    expect(caught).toBeInstanceOf(Error);
    expect(caught.config).toBeUndefined();
    const serialised = JSON.stringify({ msg: caught.message, ...caught });
    expect(serialised).not.toContain('RESET-LINK-SECRET');
    expect(serialised).not.toContain('the-signature');
    // The useful part still survives for diagnosis.
    expect(caught.message).toContain('ECONNREFUSED');
  });

  it('gives up on a response stream that never closes, instead of hanging', async () => {
    // axios' timeout covers the headers; with responseType 'stream' it has
    // already resolved. Without a deadline this await hangs, the queue row
    // stays pending, and the next pass sends the same email again.
    const { PassThrough } = require('stream');
    const neverEnds = new PassThrough(); // written to by nobody, never ended
    axios.post.mockResolvedValue({ status: 200, data: neverEnds });
    transport.__testing.setReadTimeout(25);

    const result = await transport.send(MAIL);
    expect(result.messageId).toEqual(expect.any(String));
    // The stream is torn down rather than left dangling.
    expect(neverEnds.destroyed).toBe(true);
  });

  it('prefers a messageId the receiver reports', async () => {
    axios.post.mockResolvedValue({ status: 200, data: streamOf(JSON.stringify({ messageId: 'from-n8n-123' })) });
    expect((await transport.send(MAIL)).messageId).toBe('from-n8n-123');
  });
});
