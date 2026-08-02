const crypto = require('crypto');
const { db } = require('../database/db');
const { formatBoolean } = require('../utils/dbCompat');
const { isMissingRolesSchema } = require('../utils/dbErrors');
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

    // Load the owner WITH their role name (GHSA-9697). Without it,
    // req.admin.roleName was undefined — and every ownership check keys on
    // roleName — so the v1 surface could not tell a super_admin from a
    // demoted viewer. Mirrors adminAuth's shape, including the
    // roles-table-missing fallback used during upgrades.
    let admin;
    try {
      admin = await db('admin_users')
        .leftJoin('roles', 'roles.id', 'admin_users.role_id')
        .where({ 'admin_users.id': row.created_by, 'admin_users.is_active': formatBoolean(true) })
        .select(
          'admin_users.id',
          'admin_users.username',
          'admin_users.email',
          'roles.id as role_id',
          'roles.name as role_name'
        )
        .first();
    } catch (joinError) {
      // Fail CLOSED on anything that isn't a genuinely missing roles schema:
      // the fallback fabricates super_admin, so a transient query failure must
      // not become a free privilege upgrade. Rethrow → outer catch → 500.
      if (!isMissingRolesSchema(joinError)) throw joinError;
      logger.debug('Roles table not available in apiTokenAuth', { error: joinError.message });
      admin = await db('admin_users')
        .where({ id: row.created_by, is_active: formatBoolean(true) })
        .select('id', 'username', 'email', 'role_id')
        .first();
      if (admin) admin.role_name = 'super_admin'; // upgrade-path parity with adminAuth
    }
    if (!admin) {
      return res.status(401).json({ error: 'Token owner unavailable', code: 'OWNER_INACTIVE' });
    }

    // Touch last_used_at — async, don't block the request.
    db('api_tokens').where({ id: row.id }).update({ last_used_at: new Date().toISOString() })
      .catch((err) => logger.debug('api_tokens last_used update failed', { err: err.message }));

    // Same shape adminAuth produces, so requirePermission / ownership helpers
    // behave identically whether the caller used a session or an API token.
    req.admin = {
      id: admin.id,
      username: admin.username,
      email: admin.email,
      roleId: admin.role_id,
      roleName: admin.role_name
    };
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
  isMissingRolesSchema,
  TOKEN_PREFIX,
  VALID_SCOPES
};
