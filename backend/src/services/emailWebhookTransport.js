/**
 * Webhook email transport (#1225).
 *
 * An alternative to SMTP: when EMAIL_WEBHOOK_URL is set, PicPeak POSTs the
 * composed message to that URL instead of sending it, and something downstream
 * (n8n, Make, a self-hosted relay) does the delivery.
 *
 * SMTP is the single most common thing people get stuck on in a self-hosted
 * install — app passwords, 587 vs 465, providers that reject the sender, NAS
 * boxes with no outbound 25. A webhook hands that problem to something the
 * operator usually already runs.
 *
 * Configured by environment, NOT in the admin UI. That is deliberate: this
 * setting redirects every outbound message, including password resets, so it
 * should not be changeable by a compromised admin session. It also matches how
 * the deploy that asked for this runs.
 *
 * Deliberately reuses the outbound-webhook primitives rather than growing a
 * second set: the same HMAC scheme (signPayload / X-PicPeak-Signature) so a
 * receiver verifies these exactly as it verifies gallery webhooks, and the same
 * DNS-resolving SSRF preflight.
 */

const fs = require('fs').promises;
const axios = require('axios');
const logger = require('../utils/logger');
const { signPayload } = require('./webhookService');
const { validateExternalUrlAsync } = require('../utils/networkValidation');

const SIGNATURE_HEADER = 'X-PicPeak-Signature';
const HTTP_TIMEOUT_MS = 15000;

// Attachments are base64 in the JSON body, which inflates them by a third.
// Invoices and quotes are the real users of this and run to a few hundred KB;
// the cap exists so a pathological attachment cannot build a payload large
// enough to take the process down while serialising it.
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

// Same env-var shape as WEBHOOK_ALLOW_PRIVATE_URLS. Running n8n on the same
// Docker network or LAN is the normal case for a self-hosted install, and
// refusing private addresses outright would make this useless for exactly the
// people who asked for it — so it is opt-in rather than assumed.
let allowPrivateUrls = process.env.EMAIL_WEBHOOK_ALLOW_PRIVATE_URLS === 'true';

// Logged once rather than per message: a misconfiguration is a property of the
// deploy, and one line per outbound email would bury it.
let warnedAboutMissingSecret = false;

function config() {
  return {
    url: (process.env.EMAIL_WEBHOOK_URL || '').trim(),
    secret: (process.env.EMAIL_WEBHOOK_SECRET || '').trim(),
  };
}

/**
 * Is the webhook transport configured and usable?
 *
 * A URL without a secret is treated as NOT enabled, and says so once. Sending
 * unsigned would let anything that learns the URL feed the operator's
 * automation — and every message PicPeak sends is one a receiver might act on.
 * Failing back to SMTP here means a misconfigured deploy sends by its normal
 * route rather than silently posting unauthenticated mail to the internet.
 */
function isEnabled() {
  const { url, secret } = config();
  if (!url) return false;
  if (!secret) {
    if (!warnedAboutMissingSecret) {
      warnedAboutMissingSecret = true;
      logger.error(
        '[email] EMAIL_WEBHOOK_URL is set but EMAIL_WEBHOOK_SECRET is not, so the '
        + 'webhook transport is disabled and mail will go over SMTP. Set a secret: '
        + 'the payload is signed with it (X-PicPeak-Signature), and without one '
        + 'anything that learns the URL could drive your automation.'
      );
    }
    return false;
  }
  return true;
}

/**
 * Turn nodemailer's attachment list into something a JSON body can carry.
 *
 * Callers pass `{ filename, path }` for a file already written to disk (quotes
 * and invoices do this) or `{ filename, content }` for an in-memory buffer.
 * Both become base64.
 *
 * Throws rather than dropping. The downstream implementation this was modelled
 * on logged a warning and sent the body without its attachment, which turns
 * "your invoice email failed" into "your customer received an empty invoice
 * email" — a silent partial success is the worse outcome, and the email queue
 * already surfaces and retries a throw.
 */
async function encodeAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return [];

  const encoded = [];
  let total = 0;
  for (const att of attachments) {
    if (!att) continue;
    let buffer;
    if (att.content) {
      buffer = Buffer.isBuffer(att.content) ? att.content : Buffer.from(att.content);
    } else if (att.path) {
      // stat BEFORE reading. Checking the cap only after readFile means a file
      // large enough to exhaust memory kills the process before the guard it is
      // supposed to trip — the cap would exist and never fire. The post-read
      // check below still applies, because the file can grow between the two.
      const { size } = await fs.stat(att.path);
      if (total + size > MAX_ATTACHMENT_BYTES) {
        throw new Error(
          `attachments exceed the ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB `
          + 'webhook payload limit; send this message over SMTP instead'
        );
      }
      buffer = await fs.readFile(att.path);
    } else {
      continue;
    }

    total += buffer.length;
    if (total > MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `attachments exceed the ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB `
        + 'webhook payload limit; send this message over SMTP instead'
      );
    }

    encoded.push({
      filename: att.filename,
      content_type: att.contentType || 'application/octet-stream',
      content_base64: buffer.toString('base64'),
    });
  }
  return encoded;
}

/**
 * Recipients as a flat list of single addresses.
 *
 * Splits inside array elements too, not just bare strings: sendRawEmail wraps a
 * string cc in an array before it reaches here, so "a@x, b@y" arrives as ONE
 * element. Passing that through would put a combined address in the payload,
 * which a relay treating each element as one mailbox rejects or misaddresses.
 */
function normalizeRecipients(value) {
  if (!value) return [];
  const parts = Array.isArray(value) ? value : [value];
  return parts
    .filter(Boolean)
    .flatMap((entry) => String(entry).split(/[,;]+/))
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * POST a composed message to the configured webhook.
 *
 * @param {Object} mail nodemailer-shaped options (from/to/cc/subject/html/text/attachments)
 * @returns {Promise<{ messageId: string }>} so callers match the sendMail contract
 */
async function send(mail) {
  const { url, secret } = config();

  // Vetted before every send, not once at startup: DNS answers change, and the
  // check is what stops an operator-supplied URL becoming a request to link
  // local metadata or a service on the host network.
  if (!allowPrivateUrls) {
    // https for anything leaving the machine. The HMAC proves who sent the
    // body, not who can read it — and these bodies carry password-reset links
    // and guest recovery codes, which are usable by anyone on the path. The
    // private-network opt-in doubles as the plaintext opt-in, because http to
    // a container on the same host is a different risk from http across the
    // internet.
    if (!/^https:\/\//i.test(url)) {
      throw new Error(
        'EMAIL_WEBHOOK_URL must use https:// — the payload carries password-reset '
        + 'links and recovery codes, which plaintext exposes to anyone on the path. '
        + 'Set EMAIL_WEBHOOK_ALLOW_PRIVATE_URLS=true only if the receiver is on a '
        + 'private network you trust.'
      );
    }
    const check = await validateExternalUrlAsync(url);
    if (!check.valid) {
      throw new Error(
        `EMAIL_WEBHOOK_URL rejected: ${check.error}. Set `
        + 'EMAIL_WEBHOOK_ALLOW_PRIVATE_URLS=true if the receiver really is on a '
        + 'private network (a container or LAN address).'
      );
    }
  }

  const payload = {
    from: mail.from,
    to: normalizeRecipients(mail.to),
    cc: normalizeRecipients(mail.cc),
    subject: mail.subject || '',
    html: mail.html || '',
    text: mail.text || '',
    attachments: await encodeAttachments(mail.attachments),
  };

  // Signed over the exact bytes sent, so a receiver verifies what it received
  // rather than a re-serialisation of it.
  const rawBody = JSON.stringify(payload);
  const signature = signPayload(secret, rawBody);

  // Every axios rejection is caught and replaced. An AxiosError carries the
  // request it failed on — `config.data` is the ENTIRE serialised message,
  // base64 attachments included, and `config.headers` holds the signature.
  // Callers log the error object (emailProcessor's `logger.error('Error
  // sending template email:', error)`), and winston serialises it, so a DNS
  // blip or a connection refusal would write password-reset links, recovery
  // codes and multi-megabyte invoices into combined.log — the log file being
  // exactly where none of that belongs. Only the message survives.
  let response;
  try {
    response = await axios.post(url, rawBody, {
      headers: {
        'Content-Type': 'application/json',
        [SIGNATURE_HEADER]: signature,
      },
      timeout: HTTP_TIMEOUT_MS,
      // Resolve on any status so a 4xx/5xx becomes our error message rather than
      // axios's, which does not say which webhook failed.
      validateStatus: () => true,
      maxRedirects: 0,
      // Streamed, NOT buffered with maxContentLength. axios enforces that limit
      // while reading, so a receiver that delivered the mail and then echoed a
      // large body would make this throw AFTER a successful delivery — the queue
      // would retry and the recipient would get the same email again. Reading it
      // ourselves means an oversized response costs us the messageId, never a
      // duplicate send.
      responseType: 'stream',
      // Byte length, not String#length. axios enforces this against the UTF-8
      // buffer it sends, while rawBody.length counts UTF-16 code units — every
      // umlaut is 2 bytes and every CJK character 3, so a German or Japanese
      // message would blow past a code-unit budget and axios would reject it
      // before posting. With base64 attachments in the body the gap is easily
      // more than the slack.
      maxBodyLength: Buffer.byteLength(rawBody, 'utf8') + 1024,
    });
  } catch (err) {
    // Message and code only — deliberately NOT the error object, so nothing
    // downstream can serialise the request back out of it.
    const detail = err && err.code ? `${err.code}: ${err.message}` : (err && err.message) || 'request failed';
    throw new Error(`email webhook request failed (${detail})`);
  }

  // The body is discarded unread. Only the status matters — it is the delivery
  // verdict — and the id below is synthesised either way.
  //
  // Reading it used to be worth 41 lines of bounded-read-with-deadline, to
  // recover a messageId a receiver MIGHT return. That value was only ever
  // logged: nothing persists it, there is no email_queue.message_id column. It
  // was not worth its bugs — the size cap made a delivered message retry, and
  // the missing deadline let an unclosed stream hang the queue and resend. Not
  // reading is how those stop being reachable rather than defended against.
  //
  // An error listener first: destroy() can emit on a socket-backed stream, and
  // an unhandled 'error' on a stream throws.
  if (response.data && typeof response.data.destroy === 'function') {
    response.data.on('error', () => {});
    response.data.destroy();
  }

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`email webhook returned ${response.status}`);
  }

  // Deterministic, traceable, and obviously not from a mail server.
  return { messageId: `webhook-${signature.slice(0, 16)}` };
}

module.exports = {
  isEnabled,
  send,
  // Test seams, mirroring webhookDeliveryWorker's.
  __testing: {
    SIGNATURE_HEADER,
    MAX_ATTACHMENT_BYTES,
    encodeAttachments,
    setAllowPrivateUrls(value) { allowPrivateUrls = !!value; },
    resetSecretWarning() { warnedAboutMissingSecret = false; },
  },
};
