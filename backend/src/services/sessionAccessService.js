const { db } = require('../database/db');
const { formatBoolean } = require('../utils/dbCompat');
const { isMissingRolesSchema } = require('../utils/dbErrors');
const { isTokenRevoked } = require('../utils/tokenRevocation');
const { isTokenBeforeCutoff } = require('../utils/sessionCutoff');
const { toTimestamp } = require('../utils/dateNormalize');
const { AppError } = require('../utils/errors');

/** Call only with a verified JWT payload or a signed, server-created grant. */
class SessionAccessService {
  async assertActive(session, type) {
    if (!session || session.type !== type) {
      throw new AppError('Invalid token type', 403, 'WRONG_TOKEN_TYPE');
    }
    if (!Number.isFinite(session.iat)
      || (session.exp !== undefined && (!Number.isFinite(session.exp) || session.exp <= Date.now() / 1000))) {
      throw new AppError('Token expired or invalid', 401, 'TOKEN_EXPIRED');
    }
    if (await isTokenRevoked(session)) {
      throw new AppError('Token has been revoked', 401, 'TOKEN_REVOKED');
    }
    if (await isTokenBeforeCutoff(session)) {
      throw new AppError('Session invalidated', 401, 'SESSION_INVALIDATED');
    }
  }

  assertPasswordCurrent(account, session) {
    if (account.password_changed_at == null) return;
    const changed = toTimestamp(account.password_changed_at);
    // Preserve the same-second login convention used by admin/customer auth.
    if (!Number.isFinite(changed) || session.iat < Math.floor(changed / 1000)) {
      throw new AppError('Token invalid due to password change', 401, 'PASSWORD_CHANGED');
    }
  }

  async admin(session, { includeProfile = false } = {}) {
    await this.assertActive(session, 'admin');
    let account;
    try {
      account = await db('admin_users')
        .leftJoin('roles', 'roles.id', 'admin_users.role_id')
        .where({ 'admin_users.id': session.id, 'admin_users.is_active': formatBoolean(true) })
        .select('admin_users.id', 'admin_users.username', 'admin_users.email',
          'admin_users.password_changed_at', 'roles.id as role_id', 'roles.name as role_name',
          // Always projected, never behind includeProfile: it is a security
          // flag, not profile decoration. Gating it meant a caller that forgot
          // to ask silently read `undefined` and skipped the gate - which is
          // exactly how the roles-join fallback and the gallery preview each
          // ended up bypassing it. The column is self-healed at boot
          // (database/db.js:384) and the backend refuses to serve a
          // half-migrated schema, so it is always there to select.
          'admin_users.must_change_password',
          ...(includeProfile ? ['roles.display_name as role_display_name'] : []))
        .first();
    } catch (error) {
      if (!isMissingRolesSchema(error)) throw error;
      // Same projection as the joined query for everything that is not a
      // roles column: adminAuth reads must_change_password off this account to
      // gate every request, so dropping it here turned the 403 into a silent
      // pass on exactly the upgrade-window installs this fallback exists for.
      account = await db('admin_users')
        .where({ id: session.id, is_active: formatBoolean(true) })
        .select('id', 'username', 'email', 'password_changed_at', 'must_change_password').first();
      if (account) Object.assign(account, { role_id: null, role_name: 'super_admin' });
    }
    if (!account) throw new AppError('Invalid token', 401, 'ADMIN_NOT_FOUND');
    this.assertPasswordCurrent(account, session);
    return account;
  }

  async customer(session, { derived = false } = {}) {
    if (!derived) await this.assertActive(session, 'customer');
    if (!Number.isInteger(session.customerId)) {
      throw new AppError('Invalid customer session', 401, 'CUSTOMER_NOT_FOUND');
    }
    // A gallery token minted from the portal carries the portal session's
    // identity, so logging out of the portal ends it too. Tokens minted before
    // that claim existed carry none and run out on their own (24h at most).
    if (derived && Number.isFinite(session.parentIat) && await isTokenRevoked({
      type: 'customer', customerId: session.customerId, iat: session.parentIat,
      ...(session.parentJti && { jti: session.parentJti }),
    })) {
      throw new AppError('Token has been revoked', 401, 'TOKEN_REVOKED');
    }
    const account = await db('customer_accounts')
      .where({ id: session.customerId, is_active: formatBoolean(true) })
      .select('id', 'email', 'display_name', 'first_name', 'last_name', 'password_changed_at', 'preferred_language')
      .first();
    if (!account) throw new AppError('Invalid token', 401, 'CUSTOMER_NOT_FOUND');
    this.assertPasswordCurrent(account, session);
    return account;
  }
}

module.exports = new SessionAccessService();
