const crypto = require('crypto');
const { db } = require('../database/db');
const logger = require('../utils/logger');

const TOKEN_PREFIX = 'pp_live_';
const VALID_SCOPES = ['read', 'write', 'admin'];

function hashToken(plaintext) {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

/**
 * Generate a new API token. Returns the plaintext (return once, never
 * stored) plus the row payload to insert. Caller persists.
 */
function generateApiToken() {
  const random = crypto.randomBytes(24).toString('base64url'); // 32 chars
  const plaintext = `${TOKEN_PREFIX}${random}`;
  return {
    plaintext,
    hashed: hashToken(plaintext),
    preview: random.slice(0, 8)
  };
}

function parseScopes(raw) {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => VALID_SCOPES.includes(s));
}

/**
 * Middleware: authenticate via API token. Maps the token to its owner
 * admin user, attaches { req.admin, req.apiToken }, then defers to the
 * regular permission machinery on top.
 *
 * Mount this *instead* of `adminAuth` on /api/v1/* routes. Existing
 * permission decorators (`requirePermission('events.create')`) still
 * work because they read `req.admin.id`.
 */
async function apiTokenAuth(req, res, next) {
  try {
    const header = req.headers?.authorization || '';
    if (!header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing API token', code: 'NO_TOKEN' });
    }
    const token = header.slice(7).trim();
    if (!token.startsWith(TOKEN_PREFIX)) {
      return res.status(401).json({ error: 'Invalid token format', code: 'INVALID_TOKEN' });
    }

    const hashed = hashToken(token);
    const row = await db('api_tokens').where({ hashed_token: hashed }).first();
    if (!row) {
      return res.status(401).json({ error: 'Invalid token', code: 'INVALID_TOKEN' });
    }
    if (row.revoked_at) {
      return res.status(401).json({ error: 'Token revoked', code: 'TOKEN_REVOKED' });
    }
    if (row.expires_at && new Date(row.expires_at) <= new Date()) {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }

    const admin = await db('admin_users')
      .where({ id: row.created_by, is_active: true })
      .select('id', 'username', 'email', 'role_id')
      .first();
    if (!admin) {
      return res.status(401).json({ error: 'Token owner unavailable', code: 'OWNER_INACTIVE' });
    }

    // Touch last_used_at — async, don't block the request.
    db('api_tokens').where({ id: row.id }).update({ last_used_at: new Date() })
      .catch((err) => logger.debug('api_tokens last_used update failed', { err: err.message }));

    req.admin = admin;
    req.apiToken = {
      id: row.id,
      name: row.name,
      scopes: parseScopes(row.scopes)
    };
    return next();
  } catch (error) {
    logger.error('apiTokenAuth error', { error: error.message });
    return res.status(500).json({ error: 'Authentication error' });
  }
}

/**
 * Middleware factory: require a specific scope on the API token. Use
 * after apiTokenAuth — `requireApiScope('write')` rejects read-only
 * tokens trying to mutate.
 */
function requireApiScope(scope) {
  return (req, res, next) => {
    const have = req.apiToken?.scopes || [];
    // 'admin' implies write/read; 'write' implies read.
    const expanded = new Set(have);
    if (have.includes('admin')) ['write', 'read'].forEach((s) => expanded.add(s));
    if (have.includes('write')) expanded.add('read');
    if (!expanded.has(scope)) {
      return res.status(403).json({
        error: `Token lacks required scope: ${scope}`,
        code: 'INSUFFICIENT_SCOPE',
        required: scope,
        granted: have
      });
    }
    next();
  };
}

module.exports = {
  apiTokenAuth,
  requireApiScope,
  generateApiToken,
  hashToken,
  parseScopes,
  TOKEN_PREFIX,
  VALID_SCOPES
};
