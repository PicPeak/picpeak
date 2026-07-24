/**
 * OIDC SSO for admin users (#798).
 *
 * Authorization-code + PKCE against a single configurable IdP (Keycloak,
 * Authentik, Pocket ID, or any spec-compliant provider). Phase 1: admin
 * logins only, JIT provisioning with one default role. Phase 2: role-claim
 * mapping (dot-path claim, re-evaluated per login) and login policy
 * (require-mapped-role, disable-local-login with OIDC_BREAK_GLASS env
 * escape hatch). Logout-to-IdP is a follow-up.
 *
 * Identity binding: SSO logins match on `admin_users.external_subject` (the
 * IdP's stable `sub` claim) — NEVER on email alone, which is an
 * account-takeover vector with IdPs that don't verify addresses. A one-time
 * link of an EXISTING local admin by email is allowed only when the ID token
 * carries `email_verified: true`; the sub is stamped so all future logins
 * match by sub even if the email changes. Linked local admins keep
 * `auth_provider='local'` (their password still works); JIT-provisioned rows
 * get `auth_provider='oidc'` and an unusable random password hash.
 *
 * Config lives in app_settings (oidc_* keys, managed via the dedicated
 * /admin/settings/sso endpoints). The client secret is AES-256-GCM encrypted
 * at rest — same construction as mfaService, own salt, key from
 * OIDC_ENCRYPTION_KEY (fallback JWT_SECRET).
 *
 * MFA is delegated to the IdP for SSO logins: local TOTP protects the local
 * password path, which SSO users don't take.
 */

const crypto = require('crypto');
const bcrypt = require('bcrypt');
// openid-client v5 (CommonJS). v6+ is ESM-only, which Node 22 can require()
// but Jest's CJS runtime cannot — v5 is the battle-tested major and its
// protocol coverage (discovery, PKCE, full ID-token validation) is identical
// for our flow.
const { Issuer, generators } = require('openid-client');
const { db } = require('../database/db');
const { getAppSetting, upsertAppSetting } = require('../utils/appSettings');
const { formatBoolean } = require('../utils/dbCompat');
const { getBcryptRounds } = require('../utils/passwordValidation');
const logger = require('../utils/logger');

const ENC_ALGO = 'aes-256-gcm';
const ENC_SALT = 'picpeak-oidc-secret-v1'; // fixed: derivation must be stable

// scrypt is deliberately expensive and the derivation is deterministic per
// process — memoize it, or every decrypt (e.g. config reads) burns ~50ms of
// blocking CPU on the event loop.
let _encKeyCache = null; // { material, key }

function getEncryptionKey() {
  const material = process.env.OIDC_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!material) {
    throw new Error('oidcService: OIDC_ENCRYPTION_KEY or JWT_SECRET must be set');
  }
  if (_encKeyCache && _encKeyCache.material === material) {
    return _encKeyCache.key;
  }
  const key = crypto.scryptSync(material, ENC_SALT, 32);
  _encKeyCache = { material, key };
  return key;
}

/** AES-256-GCM encrypt → "iv.tag.ciphertext" (all base64url). */
function encryptSecret(plainSecret) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENC_ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plainSecret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ct].map((b) => b.toString('base64url')).join('.');
}

/** Reverse of encryptSecret. Throws on tamper/wrong key. */
function decryptSecret(stored) {
  const key = getEncryptionKey();
  const [ivB64, tagB64, ctB64] = String(stored).split('.');
  if (!ivB64 || !tagB64 || !ctB64) {
    throw new Error('oidcService: malformed encrypted secret');
  }
  const decipher = crypto.createDecipheriv(ENC_ALGO, key, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  const pt = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]);
  return pt.toString('utf8');
}

/**
 * Read the full OIDC config from app_settings. Secret is returned DECRYPTED —
 * for internal use only; the settings GET endpoint must never call this.
 */
async function getOidcConfig() {
  const [enabled, issuerUrl, clientId, encSecret, autoprovision, defaultRole, buttonLabel, scopes,
    roleMappingEnabled, rolesClaim, roleMappings, requireMappedRole, disableLocalLogin, logoutFromIdp] =
    await Promise.all([
      getAppSetting('oidc_enabled'),
      getAppSetting('oidc_issuer_url'),
      getAppSetting('oidc_client_id'),
      getAppSetting('oidc_client_secret'),
      getAppSetting('oidc_autoprovision'),
      getAppSetting('oidc_default_role'),
      getAppSetting('oidc_button_label'),
      getAppSetting('oidc_scopes'),
      getAppSetting('oidc_role_mapping_enabled'),
      getAppSetting('oidc_roles_claim'),
      getAppSetting('oidc_role_mappings'),
      getAppSetting('oidc_require_mapped_role'),
      getAppSetting('oidc_disable_local_login'),
      getAppSetting('oidc_logout_from_idp'),
    ]);

  let clientSecret = null;
  if (encSecret) {
    try {
      clientSecret = decryptSecret(encSecret);
    } catch (err) {
      // Wrong key / tampered / plaintext-clobbered value → treat as
      // unconfigured rather than sending garbage to the IdP.
      logger.error('OIDC client secret could not be decrypted — treating SSO as unconfigured', {
        error: err.message,
      });
    }
  }

  return {
    enabled: enabled === true,
    issuerUrl: issuerUrl || null,
    clientId: clientId || null,
    clientSecret,
    autoprovision: autoprovision === true,
    defaultRole: defaultRole || 'viewer',
    buttonLabel: buttonLabel || null,
    scopes: scopes || 'openid profile email',
    roleMappingEnabled: roleMappingEnabled === true,
    rolesClaim: rolesClaim || 'roles',
    roleMappings: (roleMappings && typeof roleMappings === 'object' && !Array.isArray(roleMappings))
      ? roleMappings : {},
    requireMappedRole: requireMappedRole === true,
    disableLocalLogin: disableLocalLogin === true,
    logoutFromIdp: logoutFromIdp === true,
  };
}

/** auth_provider values that can use the password route ('local' or legacy NULL). */
function isLocalProvider(authProvider) {
  return authProvider !== 'oidc';
}

/**
 * Break-glass viability: an ACTIVE super_admin with a usable local password.
 * OIDC_BREAK_GLASS only re-opens the password route — OIDC-owned accounts
 * are refused there and carry unusable random hashes, and settings.edit is
 * super_admin-only, so this is the one account shape that can repair a
 * broken SSO config.
 */
async function hasActiveLocalSuperAdmin(conn = db) {
  const superAdminRole = await conn('roles').where('name', 'super_admin').first();
  if (!superAdminRole) return false;
  const row = await conn('admin_users')
    .where('role_id', superAdminRole.id)
    .where('is_active', formatBoolean(true))
    .where((qb) => qb.whereNot('auth_provider', 'oidc').orWhereNull('auth_provider'))
    .first();
  return Boolean(row);
}

/**
 * Whether the local password login must be refused (#798 phase 2 policy).
 * Only effective while SSO is actually usable (enabled + fully configured) —
 * a half-torn-down config must never lock the instance. OIDC_BREAK_GLASS=true
 * re-enables local login unconditionally so an IdP outage or a role-mapping
 * misconfig always has a documented way back in. The policy also disarms
 * itself when no active local-password super_admin remains (however that
 * happened — manual demotion, deactivation, deletion): break-glass would
 * otherwise re-open a password route no usable account can take.
 */
async function isLocalLoginDisabled() {
  if (process.env.OIDC_BREAK_GLASS === 'true') return false;
  const cfg = await getOidcConfig();
  if (!(cfg.enabled && cfg.disableLocalLogin && isConfigured(cfg))) return false;
  return hasActiveLocalSuperAdmin();
}

// Short-TTL cache of the flag for the UNAUTHENTICATED public-settings
// endpoint, which every new client hits — without it each request pays the
// full 14-key config read. The login route keeps using the uncached check
// (enforcement must be exact); a UI that lags a settings flip by ≤10s only
// shows a form whose submit the API answers authoritatively. Invalidated on
// every settings save in this worker.
const FLAG_CACHE_TTL_MS = 10 * 1000;
let _localLoginFlagCache = null; // { value, at }

async function isLocalLoginDisabledCached() {
  if (_localLoginFlagCache && Date.now() - _localLoginFlagCache.at < FLAG_CACHE_TTL_MS) {
    return _localLoginFlagCache.value;
  }
  const value = await isLocalLoginDisabled();
  _localLoginFlagCache = { value, at: Date.now() };
  return value;
}

function isConfigured(cfg) {
  return Boolean(cfg.issuerUrl && cfg.clientId && cfg.clientSecret);
}

// Discovery result cache. Keyed by issuer+client so a settings change gets a
// fresh client; invalidated explicitly on settings save too.
let _clientCache = null; // { key, client, issuerMetadata }

function invalidateDiscoveryCache() {
  _clientCache = null;
}

/**
 * Resolve the openid-client Client for the current settings, performing
 * OIDC discovery on first use. Throws on unreachable/invalid issuer —
 * callers surface that as a config error.
 */
async function getClient(cfg) {
  // The secret is part of the key (as a fingerprint, never plaintext): in
  // multi-worker deployments a secret rotation only invalidates the cache in
  // the worker that handled the settings request — the others must detect
  // the change through the key, or they keep signing with the old secret.
  const secretFp = crypto.createHash('sha256').update(cfg.clientSecret || '').digest('hex').slice(0, 16);
  const key = `${cfg.issuerUrl}|${cfg.clientId}|${secretFp}`;
  if (_clientCache && _clientCache.key === key) {
    return _clientCache;
  }
  const issuer = await Issuer.discover(cfg.issuerUrl);
  const client = new issuer.Client({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uris: [await getRedirectUri()],
    response_types: ['code'],
  });
  _clientCache = { key, client, issuerMetadata: issuer.metadata };
  return _clientCache;
}

/**
 * The redirect URI registered with the IdP. Derived from the public frontend
 * base URL — nginx proxies /api to the backend, so this resolves publicly.
 */
async function getRedirectUri() {
  // The callback must land on the API's public origin — that is where the
  // oidc_state cookie was set when the browser hit /sso/login. In the
  // standard deployment the frontend proxies /api on the same origin, so
  // FRONTEND_URL works; split-origin deployments set API_URL (canonically
  // ending in /api, see .env.example) and MUST be honored first or the
  // callback goes to a host that has neither the route nor the cookie.
  const apiBase = (process.env.API_URL || '').trim().replace(/\/$/, '');
  if (apiBase) {
    return `${apiBase}/auth/admin/sso/callback`;
  }
  const { getFrontendBaseUrl } = require('../utils/frontendUrl');
  const base = (await getFrontendBaseUrl()).replace(/\/$/, '');
  if (!base) {
    // Without a public base URL the redirect_uri would be relative — the IdP
    // would reject it with an opaque error on ITS side. Fail here with a
    // clear config message instead.
    const err = new Error('API_URL or FRONTEND_URL (or the general_site_url setting) must be set for SSO');
    err.code = 'OIDC_BAD_CONFIG';
    throw err;
  }
  return `${base}/api/auth/admin/sso/callback`;
}

/**
 * Build the IdP authorization URL plus the per-request secrets the callback
 * needs (state, nonce, PKCE verifier). The route stores those in a
 * short-lived signed cookie — this service is stateless across the redirect.
 */
async function buildAuthorizationRequest() {
  const cfg = await getOidcConfig();
  if (!cfg.enabled || !isConfigured(cfg)) {
    const err = new Error('SSO is not enabled or not fully configured');
    err.code = 'OIDC_NOT_CONFIGURED';
    throw err;
  }
  const { client } = await getClient(cfg);

  const codeVerifier = generators.codeVerifier();
  const codeChallenge = generators.codeChallenge(codeVerifier);
  const state = generators.state();
  const nonce = generators.nonce();

  const url = client.authorizationUrl({
    redirect_uri: await getRedirectUri(),
    scope: cfg.scopes,
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  return { url, state, nonce, codeVerifier };
}

/**
 * Exchange the authorization code and validate the ID token (issuer,
 * audience, signature, nonce, state — all enforced by openid-client).
 * Returns the ID token claims plus the raw ID token — the callback route
 * keeps the latter for RP-initiated logout (`id_token_hint`, #798 phase 3).
 */
async function handleCallback(currentUrl, { state, nonce, codeVerifier }) {
  const cfg = await getOidcConfig();
  if (!cfg.enabled || !isConfigured(cfg)) {
    const err = new Error('SSO is not enabled or not fully configured');
    err.code = 'OIDC_NOT_CONFIGURED';
    throw err;
  }
  const { client, issuerMetadata } = await getClient(cfg);

  // Extract code/state from the callback URL, then exchange + validate the
  // ID token (issuer, audience, signature, exp, nonce, state — all enforced
  // by openid-client).
  const callbackUrl = new URL(currentUrl);
  const params = Object.fromEntries(callbackUrl.searchParams.entries());
  const tokenSet = await client.callback(await getRedirectUri(), params, {
    state,
    nonce,
    code_verifier: codeVerifier,
  });

  let claims = tokenSet.claims();

  // Spec-compliant providers may deliver `profile`/`email` scope claims only
  // from the UserInfo endpoint, not inside the ID token. When the email is
  // missing there, fetch UserInfo and merge — ID-token claims win on
  // conflict (they are signature-bound to this very authorization). The sub
  // must match, or the response is discarded (spec requirement).
  if (!claims.email && issuerMetadata.userinfo_endpoint && tokenSet.access_token) {
    try {
      const userinfo = await client.userinfo(tokenSet);
      if (userinfo && userinfo.sub === claims.sub) {
        claims = { ...userinfo, ...claims };
      }
    } catch (err) {
      // Non-fatal: providers that put everything in the ID token don't need
      // this; resolveAdminFromClaims handles a still-missing email.
      logger.warn('OIDC userinfo fetch failed — proceeding with ID token claims only', {
        error: err.message,
      });
    }
  }

  return { claims, idToken: tokenSet.id_token || null };
}

/**
 * The URL guests land on after the IdP finishes its logout. Exposed in the
 * SSO settings so the admin can register it at the IdP (Keycloak: "Valid
 * post logout redirect URIs") — unregistered URIs make the IdP show an
 * error instead of returning. Empty when no public base URL is configured.
 */
async function getPostLogoutRedirectUri() {
  const { getFrontendBaseUrl } = require('../utils/frontendUrl');
  const base = ((await getFrontendBaseUrl().catch(() => '')) || '').replace(/\/$/, '');
  return base ? `${base}/admin/login` : '';
}

/**
 * RP-initiated logout URL (#798 phase 3). Returns null whenever the IdP
 * round-trip should not happen — feature off, SSO unconfigured, discovery
 * failing, or the IdP advertising no end_session_endpoint — so the caller
 * treats null as "finish the local logout normally". A logout must never
 * fail because the IdP is unreachable.
 */
/** Decode a JWT payload WITHOUT verification — only for routing decisions
 * on claims we minted no trust in (which IdP/client issued this token). */
function decodeJwtPayload(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
}

async function buildEndSessionUrl(idTokenHint) {
  try {
    const cfg = await getOidcConfig();
    if (!cfg.enabled || !cfg.logoutFromIdp || !isConfigured(cfg)) return null;
    const { client, issuerMetadata } = await getClient(cfg);
    if (!issuerMetadata.end_session_endpoint) return null;

    // The hint comes from a cookie minted at login — the OIDC config may
    // have changed since. A token from a DIFFERENT issuer means the session
    // belongs to another IdP entirely: skip the round-trip (ending the new
    // IdP's session would be wrong, and providers that validate the hint
    // would strand the user on an error page). Same issuer but a different
    // client (aud): the hint is unusable, but the browser's IdP session is
    // real — round-trip without the hint.
    let hint = idTokenHint;
    if (hint) {
      const payload = decodeJwtPayload(hint);
      if (!payload || payload.iss !== issuerMetadata.issuer) return null;
      const audMatches = Array.isArray(payload.aud)
        ? payload.aud.includes(cfg.clientId)
        : payload.aud === cfg.clientId;
      if (!audMatches) hint = undefined;
    }

    const postLogoutRedirectUri = await getPostLogoutRedirectUri();
    return client.endSessionUrl({
      // Without the hint most IdPs (Keycloak included) fall back to a
      // "do you really want to log out?" confirmation page — still correct,
      // just one extra click. client_id keeps the request valid either way.
      ...(hint ? { id_token_hint: hint } : {}),
      ...(postLogoutRedirectUri ? { post_logout_redirect_uri: postLogoutRedirectUri } : {}),
      client_id: cfg.clientId,
    });
  } catch (err) {
    logger.warn('OIDC end-session URL could not be built — finishing local logout only', {
      error: err.message,
    });
    return null;
  }
}

/**
 * Pull the IdP role values out of the claims via a dot-path (#798 phase 2).
 * Keycloak nests them (`realm_access.roles`), Authentik uses a flat `groups`,
 * Entra a flat `roles`/`groups` — a dot-path covers all of them. Accepts an
 * array, a single string, or a space/comma-separated string value.
 */
function extractRolesFromClaims(claims, claimPath) {
  const path = String(claimPath || '').trim();
  if (!path) return [];
  let value = claims;
  for (const segment of path.split('.')) {
    if (value == null || typeof value !== 'object') return [];
    value = value[segment];
  }
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string');
  if (typeof value === 'string') return value.split(/[\s,]+/).filter(Boolean);
  return [];
}

/**
 * Resolve the IdP-asserted roles to ONE PicPeak role row through the
 * configured mapping table, or null when nothing maps. Several matches →
 * the highest-priority role wins (roles.priority, super_admin=100 …
 * viewer=20). Mapping targets that don't exist in the roles table anymore
 * (deleted custom role) simply resolve to nothing.
 */
async function resolveMappedRole(claims, cfg) {
  const idpRoles = extractRolesFromClaims(claims, cfg.rolesClaim);
  // Own-property lookup only: an IdP value like `constructor` or `toString`
  // would otherwise resolve to an inherited function and corrupt the query —
  // such values must count as unmapped, not break the login.
  const targetNames = [...new Set(
    idpRoles
      .map((r) => (Object.hasOwn(cfg.roleMappings, r) ? cfg.roleMappings[r] : null))
      .filter((v) => typeof v === 'string' && v.length > 0)
  )];
  if (targetNames.length === 0) return null;
  const roles = await db('roles').whereIn('name', targetNames).orderBy('priority', 'desc');
  return roles[0] || null;
}

/**
 * Apply the mapped role to an admin row (role re-evaluated on every SSO
 * login — the IdP is the source of truth while mapping is enabled). One
 * guard: NEVER demote the last active super_admin, or a bad IdP group
 * change would leave the instance without user management (same invariant
 * userManagementService enforces on manual role edits). `mappedRole=null`
 * (mapping off, or nothing mapped in non-strict mode) keeps the current role.
 */
async function syncAdminRole(admin, mappedRole) {
  if (!mappedRole || admin.role_id === mappedRole.id) return admin;

  const superAdminRole = await db('roles').where('name', 'super_admin').first();
  if (superAdminRole && admin.role_id === superAdminRole.id && mappedRole.id !== superAdminRole.id) {
    // Demotion of a super_admin must be count-and-update ATOMIC: two supers
    // finishing mapped callbacks concurrently would otherwise both count 2
    // and both demote, leaving zero super_admins. FOR UPDATE on the active
    // super rows serializes concurrent demotions on Postgres (the second
    // waiter re-reads after the first commits and sees the shrunken set);
    // SQLite ignores forUpdate but is single-writer anyway. Use only `trx`
    // inside — a global-db read here would deadlock SQLite's one-connection
    // pool (see utils/appSettings.js).
    let demoted = false;
    await db.transaction(async (trx) => {
      const activeSupers = await trx('admin_users')
        .where('role_id', superAdminRole.id)
        .where('is_active', formatBoolean(true))
        .select('id', 'auth_provider')
        .forUpdate();
      const others = activeSupers.filter((row) => row.id !== admin.id);
      if (others.length === 0) return; // last active super_admin — keep
      // A LOCAL-password super is also the break-glass account for SSO-only
      // mode: demoting the last one would leave only OIDC-owned supers,
      // which the password route refuses — keep it regardless of what the
      // IdP asserts.
      if (isLocalProvider(admin.auth_provider) && !others.some((row) => isLocalProvider(row.auth_provider))) {
        return;
      }
      await trx('admin_users').where('id', admin.id).update({
        role_id: mappedRole.id,
        updated_at: new Date(),
      });
      demoted = true;
    });
    if (!demoted) {
      logger.warn('OIDC role sync would demote the last active (local-password) super_admin — keeping super_admin', {
        adminId: admin.id,
        mappedRole: mappedRole.name,
      });
      return admin;
    }
    logger.info('OIDC: admin role synced from IdP claims', { adminId: admin.id, role: mappedRole.name });
    return { ...admin, role_id: mappedRole.id };
  }

  await db('admin_users').where('id', admin.id).update({
    role_id: mappedRole.id,
    updated_at: new Date(),
  });
  logger.info('OIDC: admin role synced from IdP claims', { adminId: admin.id, role: mappedRole.name });
  return { ...admin, role_id: mappedRole.id };
}

/**
 * Map validated ID token claims to an admin_users row.
 *
 * Resolution order:
 *   1. (external_issuer, external_subject) === (iss, sub) → that admin
 *      (must be active). Matching includes the issuer because OIDC only
 *      guarantees sub uniqueness WITHIN an issuer — a lookup on sub alone
 *      would let a user of a newly-configured IdP inherit an old IdP's
 *      admin account on a subject collision.
 *   2. email match against an UNLINKED admin, only if email_verified === true
 *      → one-time link (stamps issuer+subject; auth_provider unchanged so
 *      a local password keeps working).
 *   3. JIT provisioning when oidc_autoprovision is on (requires an email
 *      claim; role = oidc_default_role; unusable random password).
 *
 * Errors carry a `code` the route maps to a redirect error key.
 */
async function resolveAdminFromClaims(claims) {
  const sub = claims.sub;
  const iss = claims.iss;
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : null;
  const emailVerified = claims.email_verified === true;

  if (!sub || !iss) {
    const err = new Error('ID token has no sub/iss claim');
    err.code = 'OIDC_BAD_CLAIMS';
    throw err;
  }

  const cfg = await getOidcConfig();

  // Role mapping (#798 phase 2): resolve the IdP-asserted role ONCE, before
  // any account resolution — in strict mode a login without a mapped role is
  // refused no matter how the identity would have resolved ("only members of
  // group X may enter"). The mapped role is then applied on every path below.
  let mappedRole = null;
  if (cfg.roleMappingEnabled) {
    mappedRole = await resolveMappedRole(claims, cfg);
    if (!mappedRole && cfg.requireMappedRole) {
      const err = new Error('ID token carries no role that maps to a PicPeak role');
      err.code = 'OIDC_NO_ROLE';
      throw err;
    }
  }

  // 1. Established binding — issuer AND subject.
  const bySub = await db('admin_users')
    .where('external_issuer', iss)
    .where('external_subject', sub)
    .first();
  if (bySub) {
    if (!bySub.is_active) {
      const err = new Error('Admin account is deactivated');
      err.code = 'OIDC_INACTIVE';
      throw err;
    }
    return syncAdminRole(bySub, mappedRole);
  }

  // 2. One-time email link — verified emails only, and only onto rows that
  //    have no binding yet (a different identity on the row means a
  //    different IdP identity already owns it).
  if (email && emailVerified) {
    const byEmail = await db('admin_users')
      .where('email', email)
      .whereNull('external_subject')
      .first();
    if (byEmail) {
      if (!byEmail.is_active) {
        const err = new Error('Admin account is deactivated');
        err.code = 'OIDC_INACTIVE';
        throw err;
      }
      // Claim atomically: two concurrent first-time callbacks with the same
      // email but DIFFERENT subjects must not both authenticate as this
      // admin — the conditional update lets exactly one win.
      const claimed = await db('admin_users')
        .where('id', byEmail.id)
        .whereNull('external_subject')
        .update({
          external_issuer: iss,
          external_subject: sub,
          updated_at: new Date(),
        });
      if (claimed !== 1) {
        // Lost the race. If the winner was this very identity (double-click,
        // parallel tabs), the binding lookup now succeeds; anything else is
        // an unbound identity again and must not proceed as this admin.
        const rebound = await db('admin_users')
          .where('external_issuer', iss)
          .where('external_subject', sub)
          .first();
        if (rebound && rebound.is_active) return syncAdminRole(rebound, mappedRole);
        const err = new Error('Account link raced with another sign-in — try again');
        err.code = 'OIDC_BAD_CLAIMS';
        throw err;
      }
      logger.info('OIDC: linked existing admin to IdP subject', {
        adminId: byEmail.id,
        sub,
      });
      return syncAdminRole({ ...byEmail, external_issuer: iss, external_subject: sub }, mappedRole);
    }
  }

  // 3. JIT provisioning.
  if (!cfg.autoprovision) {
    const err = new Error('No matching admin account and auto-provisioning is disabled');
    err.code = 'OIDC_NOT_PROVISIONED';
    throw err;
  }
  if (!email) {
    const err = new Error('IdP supplied no email claim — cannot provision an account');
    err.code = 'OIDC_NO_EMAIL';
    throw err;
  }

  // Mapped role wins over the static default — the default only catches
  // users with no mapped IdP role while non-strict mapping is on.
  const role = mappedRole || await db('roles').where('name', cfg.defaultRole).first();
  if (!role) {
    const err = new Error(`Configured default role '${cfg.defaultRole}' does not exist`);
    err.code = 'OIDC_BAD_CONFIG';
    throw err;
  }

  // Unusable-but-valid bcrypt hash: local login always fails for this row,
  // and nothing downstream chokes on a malformed hash.
  const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('base64url'), getBcryptRounds());

  const inserted = await db('admin_users')
    .insert({
      username: email,
      email,
      password_hash: passwordHash,
      role_id: role.id,
      is_active: formatBoolean(true),
      must_change_password: formatBoolean(false),
      auth_provider: 'oidc',
      external_issuer: iss,
      external_subject: sub,
      created_at: new Date(),
      updated_at: new Date(),
    })
    .returning('id');
  const adminId = inserted[0]?.id || inserted[0];
  logger.info('OIDC: JIT-provisioned admin from IdP', { adminId, sub, role: role.name });

  return db('admin_users').where('id', adminId).first();
}

/**
 * Persist SSO settings (dedicated endpoint — the generic settings upserts
 * strip oidc_client_secret so it can't be clobbered with plaintext).
 * An absent/empty secret keeps the stored one.
 */
async function saveOidcSettings(input) {
  const writes = [];
  const put = (key, value, type) => writes.push(upsertAppSetting(key, JSON.stringify(value), type));

  if (input.oidc_enabled !== undefined) put('oidc_enabled', input.oidc_enabled === true, 'boolean');
  if (input.oidc_issuer_url !== undefined) put('oidc_issuer_url', String(input.oidc_issuer_url).trim(), 'string');
  if (input.oidc_client_id !== undefined) put('oidc_client_id', String(input.oidc_client_id).trim(), 'string');
  if (input.oidc_autoprovision !== undefined) put('oidc_autoprovision', input.oidc_autoprovision === true, 'boolean');
  if (input.oidc_default_role !== undefined) put('oidc_default_role', String(input.oidc_default_role).trim(), 'string');
  if (input.oidc_button_label !== undefined) put('oidc_button_label', String(input.oidc_button_label).trim(), 'string');
  if (input.oidc_scopes !== undefined) {
    // The `openid` scope is what makes this OIDC rather than plain OAuth —
    // without it there is no ID token and the callback cannot authenticate
    // anyone. Force it in rather than trusting the admin's edit.
    const scopes = String(input.oidc_scopes).trim().split(/\s+/).filter(Boolean);
    if (!scopes.includes('openid')) scopes.unshift('openid');
    put('oidc_scopes', scopes.join(' ') || 'openid profile email', 'string');
  }
  if (input.oidc_role_mapping_enabled !== undefined) put('oidc_role_mapping_enabled', input.oidc_role_mapping_enabled === true, 'boolean');
  if (input.oidc_roles_claim !== undefined) put('oidc_roles_claim', String(input.oidc_roles_claim).trim(), 'string');
  if (input.oidc_role_mappings !== undefined) {
    // Normalize to a flat { idpRole: picpeakRole } string map; the route has
    // already validated that every target role exists.
    const mappings = {};
    if (input.oidc_role_mappings && typeof input.oidc_role_mappings === 'object' && !Array.isArray(input.oidc_role_mappings)) {
      for (const [idpRole, picpeakRole] of Object.entries(input.oidc_role_mappings)) {
        const from = String(idpRole).trim();
        const to = String(picpeakRole).trim();
        if (from && to) mappings[from] = to;
      }
    }
    put('oidc_role_mappings', mappings, 'json');
  }
  if (input.oidc_require_mapped_role !== undefined) put('oidc_require_mapped_role', input.oidc_require_mapped_role === true, 'boolean');
  if (input.oidc_disable_local_login !== undefined) put('oidc_disable_local_login', input.oidc_disable_local_login === true, 'boolean');
  if (input.oidc_logout_from_idp !== undefined) put('oidc_logout_from_idp', input.oidc_logout_from_idp === true, 'boolean');
  if (typeof input.oidc_client_secret === 'string' && input.oidc_client_secret.length > 0) {
    put('oidc_client_secret', encryptSecret(input.oidc_client_secret), 'string');
  }

  await Promise.all(writes);
  invalidateDiscoveryCache();
  _localLoginFlagCache = null;
}

module.exports = {
  getOidcConfig,
  isConfigured,
  isLocalLoginDisabled,
  isLocalLoginDisabledCached,
  hasActiveLocalSuperAdmin,
  extractRolesFromClaims,
  resolveMappedRole,
  getRedirectUri,
  getPostLogoutRedirectUri,
  buildAuthorizationRequest,
  handleCallback,
  buildEndSessionUrl,
  resolveAdminFromClaims,
  saveOidcSettings,
  invalidateDiscoveryCache,
  getClient,
  encryptSecret,
  decryptSecret,
};
