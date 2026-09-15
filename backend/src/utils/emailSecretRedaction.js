/**
 * Keep passwords out of the email archive.
 *
 * email_queue rows carry the template variables (`email_data`) and, since
 * migration 119, the exact HTML that went out (`rendered_html`). The
 * gallery-created email includes the gallery password and the client PIN,
 * so both columns held those in clear text for the life of the event, and
 * the Messages reading pane returned them to any admin with email.view.
 * Gallery passwords are bcrypt-hashed everywhere else; this was the one
 * place they survived in plain text.
 *
 * The variables have to stay intact until the mail is out — the processor
 * renders from them, and a retry needs them again — so the scrub runs when
 * a row reaches a final state (sent, or out of retries). Rows written before
 * that are redacted on read from the same rule.
 */

const SECRET_KEY_RE = /password|passcode|\bpin\b|_pin$/i;
const MASK = '••••••';
// Template sentinels the email pipeline uses in place of a real password.
// They are not secrets and masking them would hide what the email said.
const SENTINELS = new Set(['{{password_security_message}}', 'No password required', '(set at creation)', MASK]);

function isSecretKey(key) {
  return SECRET_KEY_RE.test(String(key));
}

function isRealSecret(value) {
  return typeof value === 'string' && value.length > 0 && !SENTINELS.has(value);
}

/** The secret strings inside a template-variable object, deduplicated. */
function secretValues(emailData) {
  const out = new Set();
  const walk = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [key, value] of Object.entries(obj)) {
      if (value && typeof value === 'object') walk(value);
      else if (isSecretKey(key) && isRealSecret(value)) out.add(value);
    }
  };
  walk(emailData);
  return [...out];
}

/** A copy of the template variables with every secret replaced by the mask. */
function redactEmailData(emailData) {
  if (!emailData || typeof emailData !== 'object') return emailData;
  const copy = Array.isArray(emailData) ? [] : {};
  for (const [key, value] of Object.entries(emailData)) {
    if (value && typeof value === 'object') copy[key] = redactEmailData(value);
    else copy[key] = isSecretKey(key) && isRealSecret(value) ? MASK : value;
  }
  return copy;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Replace every occurrence of the given secrets in a rendered body — as
 * typed, and as the template engine would have HTML-escaped it.
 */
function redactRenderedHtml(html, secrets) {
  if (!html || !secrets || !secrets.length) return html;
  // One pass per group, longest form first: when one secret contains
  // another ('Sunset-42!' inside 'Sunset-42!7788'), replacing the short one
  // first would leave the tail of the long one readable.
  const forms = [...new Set(secrets.flatMap((secret) => [secret, escapeHtml(secret)]))]
    .filter((form) => form.length > 0)
    .sort((a, b) => b.length - a.length);
  const alternation = (list) => new RegExp(list.map(escapeRegExp).join('|'), 'g');
  // A word-like secret ('href', 'style', '7788') could also be a tag or
  // attribute name, so it is only replaced in text and quoted attribute
  // values. Anything else cannot be markup and is replaced wherever it
  // occurs — including a raw 'Se<cr3t>Pin' that the splitter would cut.
  const wordLike = forms.filter((form) => /^[\w-]+$/.test(form));
  const other = forms.filter((form) => !/^[\w-]+$/.test(form));
  let out = String(html);
  if (other.length) out = out.replace(alternation(other), MASK);
  if (!wordLike.length) return out;
  const scrub = (text) => text.replace(alternation(wordLike), MASK);
  // A '>' inside a quoted attribute value (title="{{gallery_password}} > more")
  // must not end the tag, or the value is cut off and never scrubbed. A tag
  // with an unbalanced quote does not match and is scrubbed as text instead.
  // A comment (<!-- PIN: {{client_password}} -->) is one segment and its body
  // is scrubbed whole: it holds no tag or attribute names.
  return out.split(/(<!--[\s\S]*?-->|<(?:[^>"']|"[^"]*"|'[^']*')*>)/).map((segment, index) => {
    if (index % 2 === 0) return scrub(segment);
    if (segment.startsWith('<!--')) return `<!--${scrub(segment.slice(4, -3))}-->`;
    // attribute values, quoted or not; never the tag or attribute names
    return segment.replace(/(=\s*)("[^"]*"|'[^']*'|[^\s"'>]+)/g, (_, eq, value) => eq + scrub(value));
  }).join('');
}

// Contract and quote emails link to `/contract/<64 hex>` and `/quote/<64 hex>`,
// and that path segment is the link's bearer token. The archived body keeps it
// for as long as the row lives, and the Messages pane and the project cockpit
// serve that body to admins who hold no contract or quote permission. Only the
// token is masked, so the preview still shows that the email carried a link.
const DOCUMENT_LINK_TOKEN_RE = /(\/(?:contracts?|quotes?)\/)[a-f0-9]{64}(?![a-f0-9])/gi;

/** A copy of an email body with document-link tokens masked. */
function redactDocumentLinks(html) {
  if (!html) return html;
  return String(html).replace(DOCUMENT_LINK_TOKEN_RE, `$1${MASK}`);
}

/** Parse a stored email_data column leniently (string or already-parsed). */
function parseEmailData(raw) {
  if (!raw) return {};
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

/**
 * Undo the archive mask for a row that is about to be SENT again (Messages
 * "resend" copies a sent row's variables into a new pending row, "retry"
 * and "send now" re-queue the row itself). The real value is gone; the
 * pipeline's security sentinel makes the template say so instead of
 * mailing six dots as the password. Applied by processEmailQueue, so every
 * requeue path is covered.
 */
function replaceMaskedSecrets(emailData, sentinel = '{{password_security_message}}') {
  const walk = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(walk);
    const out = {};
    for (const [key, value] of Object.entries(obj)) {
      if (value && typeof value === 'object') out[key] = walk(value);
      else if (isSecretKey(key) && value === MASK) out[key] = sentinel;
      else out[key] = value;
    }
    return out;
  };
  return walk(emailData);
}

// Invitation and password-reset emails link to `/invite/<64 hex>`,
// `/customer/invite/<64 hex>` and `/customer/reset-password/<64 hex>`. That
// token sets the password of the account, so whoever can read the archived
// mail can take the account over — including a pending super-admin invite
// read by an admin who only holds email.view. Unlike a contract link, the
// archive has no use for it once the mail is out.
const RECOVERY_LINK_TOKEN_RE = /(\/(?:customer\/)?(?:invite|reset-password)\/)[a-f0-9]{64}(?![a-f0-9])/gi;

// Workflow approval and payment-check emails go to the admin and act without
// a login: `/api/public/workflow-approvals/<64 hex>/confirm` and
// `/payment-check/<64 hex>?action=…`. Masked for readers of the archive; the
// stored row keeps them, like document links.
const ACTION_LINK_TOKEN_RE = /(\/(?:api\/public\/workflow-approvals|payment-check)\/)[a-f0-9]{64}(?![a-f0-9])/gi;

/** A copy of a string with invitation and password-reset link tokens masked. */
function redactRecoveryLinks(text) {
  if (!text) return text;
  return String(text).replace(RECOVERY_LINK_TOKEN_RE, `$1${MASK}`);
}

/** Template variables with every recovery link token masked, at any depth. */
function redactRecoveryLinksInData(emailData) {
  if (!emailData || typeof emailData !== 'object') return emailData;
  const copy = Array.isArray(emailData) ? [] : {};
  for (const [key, value] of Object.entries(emailData)) {
    if (value && typeof value === 'object') copy[key] = redactRecoveryLinksInData(value);
    else copy[key] = typeof value === 'string' ? redactRecoveryLinks(value) : value;
  }
  return copy;
}

/**
 * Whether archived variables carry a recovery link whose token was masked.
 * Such a row cannot be sent again: the mail would carry a dead link.
 */
function hasMaskedRecoveryLink(emailData) {
  const needle = new RegExp(`/(?:customer/)?(?:invite|reset-password)/${escapeRegExp(MASK)}`);
  const walk = (value) => {
    if (typeof value === 'string') return needle.test(value);
    if (value && typeof value === 'object') return Object.values(value).some(walk);
    return false;
  };
  return walk(emailData);
}

/**
 * An email body as shown to admins reading the archive: every bearer link
 * token masked — documents, account recovery, and admin action links.
 */
function redactBearerLinks(html) {
  if (!html) return html;
  return redactDocumentLinks(String(html))
    .replace(RECOVERY_LINK_TOKEN_RE, `$1${MASK}`)
    .replace(ACTION_LINK_TOKEN_RE, `$1${MASK}`);
}

module.exports = {
  replaceMaskedSecrets, MASK, isSecretKey, secretValues, redactEmailData, redactRenderedHtml, redactDocumentLinks, parseEmailData,
  redactRecoveryLinks, redactRecoveryLinksInData, hasMaskedRecoveryLink, redactBearerLinks };
