/**
 * A stored mail password belongs to the server it was saved for.
 *
 * The SMTP/IMAP forms send the password back masked ('********') or blank so
 * the admin never retypes it, and the server keeps the stored value. That is
 * only safe while the connection still goes where the password was saved
 * for: once host, port, username or encryption changes, reusing it hands the
 * stored secret to whatever server the caller named — a test button or a
 * save-then-poll is enough to capture it. These helpers decide when a masked
 * password may fall back to the stored one.
 */

const MASKED_PASSWORD = '********';

function isMaskedOrBlank(password) {
  return password === undefined || password === null || password === '' || password === MASKED_PASSWORD;
}

const normHost = (host) => String(host || '').trim().toLowerCase().replace(/\.$/, '');
const normUser = (user) => String(user || '').trim();
const normPort = (port, fallback) => {
  const n = parseInt(port, 10);
  return Number.isFinite(n) ? n : fallback;
};
const truthy = (value) => value === true || value === 1 || value === '1' || value === 'true';

/**
 * Same SMTP destination: host, port, username and implicit TLS.
 * `saved` uses the email_configs / mail_accounts column names.
 */
function sameSmtpTarget(saved, next) {
  if (!saved) return false;
  return normHost(saved.smtp_host) === normHost(next.smtp_host)
    && normPort(saved.smtp_port, 587) === normPort(next.smtp_port, 587)
    && normUser(saved.smtp_user) === normUser(next.smtp_user)
    && truthy(saved.smtp_secure) === truthy(next.smtp_secure);
}

/**
 * Same IMAP destination. IMAP defaults to implicit TLS, so only an explicit
 * false/0 turns it off (matching emailIntakeService).
 */
function sameImapTarget(saved, next) {
  if (!saved) return false;
  const secure = (value) => value !== false && value !== 0 && value !== '0' && value !== 'false';
  return normHost(saved.imap_host) === normHost(next.imap_host)
    && normPort(saved.imap_port, 993) === normPort(next.imap_port, 993)
    && normUser(saved.imap_user) === normUser(next.imap_user)
    && secure(saved.imap_secure) === secure(next.imap_secure);
}

class PasswordRequiredError extends Error {
  constructor(message) {
    super(message);
    this.code = 'PASSWORD_REQUIRED';
    this.statusCode = 400;
  }
}

module.exports = {
  MASKED_PASSWORD,
  isMaskedOrBlank,
  sameSmtpTarget,
  sameImapTarget,
  PasswordRequiredError,
};
