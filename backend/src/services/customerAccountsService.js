/**
 * Customer Accounts Service
 *
 * Recurring user logins (the third user tier alongside admin and guest).
 * See discussion the-luap/picpeak#354 and migration 087 for context.
 *
 * Mirrors userManagementService.js for invitation lifecycle but operates
 * on customer_accounts / customer_invitations / event_customer_assignments
 * — separate token type ('customer'), simpler permission model (a customer
 * either has access to a given event or doesn't, no RBAC).
 */

const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { db, logActivity } = require('../database/db');
const { formatBoolean } = require('../utils/dbCompat');
const { getBcryptRounds } = require('../utils/passwordValidation');
const { queueEmail } = require('./emailProcessor');
const { getFrontendBaseUrl } = require('../utils/frontendUrl');
const logger = require('../utils/logger');
const { ConflictError, NotFoundError, ValidationError } = require('../utils/errors');

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, matches admin invites

/**
 * Whitelist of customer profile fields the admin is allowed to pre-fill on
 * an invitation (and that the customer can then edit on accept). Centralised
 * so both invite-create and accept paths agree on what survives the round
 * trip.
 */
const PREFILLABLE_FIELDS = [
  'salutation',
  'first_name',
  'last_name',
  'display_name',
  'phone',
  'company_name',
  'vat_id',
  'address_line1',
  'address_line2',
  'postal_code',
  'city',
  'state',
  'country_code',
];

/**
 * Sanitise a free-form prefill payload coming from the admin UI. Trims
 * whitespace, drops anything not in the whitelist, uppercases ISO country
 * codes, and returns null if the result is effectively empty so we don't
 * litter the DB with `{}` rows.
 */
function sanitisePrefill(input) {
  if (!input || typeof input !== 'object') return null;
  const out = {};
  for (const field of PREFILLABLE_FIELDS) {
    const raw = input[field];
    if (raw === undefined || raw === null) continue;
    const trimmed = String(raw).trim();
    if (!trimmed) continue;
    if (field === 'country_code') {
      out[field] = trimmed.toUpperCase().slice(0, 2);
    } else {
      out[field] = trimmed;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Decode the prefill_data column. Postgres returns it pre-parsed; SQLite /
 * older drivers may hand back a JSON string. Tolerate both, fail soft.
 */
function decodePrefill(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Create a new customer invitation.
 *
 * Idempotency: rejects if an active customer with this email already
 * exists, OR if a non-expired pending invitation is already in flight.
 * The latter is intentional — re-sending an invite while one is open
 * would mint two valid tokens, doubling the attack surface. Admins must
 * cancel the open invitation first if they want to re-send.
 *
 * @returns {Promise<{ id, email, token, expiresAt }>}
 */
async function createInvitation({ email, invitedById, prefill }) {
  const normalisedEmail = String(email || '').trim().toLowerCase();
  if (!normalisedEmail) {
    throw new ValidationError('Email is required');
  }

  const existingCustomer = await db('customer_accounts')
    .where('email', normalisedEmail)
    .first();
  if (existingCustomer) {
    throw new ConflictError('A customer account with this email already exists', 'email');
  }

  const pendingInvite = await db('customer_invitations')
    .where('email', normalisedEmail)
    .whereNull('accepted_at')
    .where('expires_at', '>', new Date())
    .first();
  if (pendingInvite) {
    throw new ConflictError('A pending invitation already exists for this email', 'email');
  }

  // 64-char hex = 32 bytes = 256 bits of entropy. Same as admin invites.
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
  const sanitisedPrefill = sanitisePrefill(prefill);

  const [insertedId] = await db('customer_invitations').insert({
    email: normalisedEmail,
    token,
    invited_by: invitedById,
    expires_at: expiresAt,
    created_at: new Date(),
    // Stringify so SQLite (TEXT-typed json column) and Postgres (JSONB)
    // both store the same shape. Skip the column entirely on null so
    // databases predating migration 088 don't reject the insert.
    ...(sanitisedPrefill ? { prefill_data: JSON.stringify(sanitisedPrefill) } : {}),
  }).returning('id');
  const id = insertedId?.id || insertedId;

  // Queue invitation email. The customer-facing accept page lives at
  // /customer/invite/:token (see CustomerAcceptInvitePage.tsx).
  //
  // Resolve the frontend base URL through the shared helper so the link
  // honours Site Settings → Site URL (general_site_url) rather than the
  // local FRONTEND_URL env var. The helper still falls back to
  // FRONTEND_URL → 'http://localhost:3000' if the setting isn't set, but
  // a configured deployment will always use its real domain. (Admin
  // invites in userManagementService use the env-only fallback — that's
  // a separate bug to be fixed alongside this PR or after.)
  const frontendUrl = (await getFrontendBaseUrl()) || 'http://localhost:3000';
  await queueEmail(null, normalisedEmail, 'customer_invitation', {
    invite_link: `${frontendUrl}/customer/invite/${token}`,
    expires_at: expiresAt.toISOString(),
  });

  await logActivity('customer_invitation_created',
    { email: normalisedEmail },
    null,
    { type: 'admin', id: invitedById, name: 'system' }
  );

  logger.info('Customer invitation created', { email: normalisedEmail, invitedById });
  return { id, email: normalisedEmail, token, expiresAt };
}

/**
 * Accept an invitation. Creates the customer_accounts row in a transaction
 * and marks the invitation accepted, so a partial failure can't leave a
 * dangling account or a re-usable token.
 */
async function acceptInvitation({ token, name, password, profile }) {
  const invitation = await db('customer_invitations')
    .where('token', token)
    .whereNull('accepted_at')
    .where('expires_at', '>', new Date())
    .first();

  if (!invitation) {
    throw new ValidationError('Invalid or expired invitation');
  }

  // Race-condition guard: an admin may have created the customer manually
  // (future flow) between the invite link being generated and clicked.
  const existing = await db('customer_accounts')
    .where('email', invitation.email)
    .first();
  if (existing) {
    throw new ConflictError('Email already registered', 'email');
  }

  const passwordHash = await bcrypt.hash(password, getBcryptRounds());

  // Merge the admin's prefill with whatever the customer typed on the accept
  // form. Customer-supplied values win on every key — the accept page shows
  // the prefill values pre-populated but the customer is allowed to correct
  // anything (e.g. an admin's typo in the company name).
  const adminPrefill = decodePrefill(invitation.prefill_data) || {};
  const customerProfile = sanitisePrefill(profile) || {};
  const merged = { ...adminPrefill, ...customerProfile };
  // The legacy single-name field still wins over a separately-typed
  // display_name only if the merged record didn't carry one. Keeps backwards
  // compatibility with clients that haven't been updated to send the
  // structured profile.
  if (name && !merged.display_name) {
    merged.display_name = String(name).trim();
  }

  const customerId = await db.transaction(async (trx) => {
    const [inserted] = await trx('customer_accounts').insert({
      email: invitation.email,
      // Profile fields land directly on the customer row. Anything the user
      // didn't set stays null.
      salutation: merged.salutation || null,
      first_name: merged.first_name || null,
      last_name: merged.last_name || null,
      display_name: merged.display_name || null,
      phone: merged.phone || null,
      company_name: merged.company_name || null,
      vat_id: merged.vat_id || null,
      address_line1: merged.address_line1 || null,
      address_line2: merged.address_line2 || null,
      postal_code: merged.postal_code || null,
      city: merged.city || null,
      state: merged.state || null,
      country_code: merged.country_code || null,
      password_hash: passwordHash,
      is_active: formatBoolean(true),
      // must_change_password is decorative today — accept-invite always
      // sets a customer-chosen password, so this flag is never true and
      // customerAuth doesn't read it. TODO when we ship an "admin
      // pre-loads a temporary password" flow: surface a code in the
      // login response (mirroring adminAuth's MUST_CHANGE_PASSWORD) and
      // add a /change-password gate to customerAuth.
      must_change_password: formatBoolean(false),
      // Leave password_changed_at NULL on initial accept. Setting it here
      // creates a millisecond/second-rounding race with the JWT issued
      // by the immediate /login call: stored timestamp X.500ms can floor
      // to X+1 in postgres while the JWT's iat lands at X, causing the
      // customerAuth middleware's `iat < password_changed_at` check to
      // reject perfectly valid tokens on the very next page reload. We
      // populate password_changed_at only when an actual password change
      // happens later (deactivate / reset flows).
      password_changed_at: null,
      created_by_admin_id: invitation.invited_by,
      created_at: new Date(),
      updated_at: new Date(),
    }).returning('id');
    const id = inserted?.id || inserted;

    await trx('customer_invitations')
      .where('id', invitation.id)
      .update({ accepted_at: new Date(), accepted_customer_id: id });

    return id;
  });

  await logActivity('customer_invitation_accepted',
    { customerId, email: invitation.email, invitationId: invitation.id },
    null,
    { type: 'system', id: null, name: 'system' }
  );

  logger.info('Customer invitation accepted', { customerId, email: invitation.email });
  return { customerId, email: invitation.email };
}

/**
 * Look up an invitation token without consuming it. Used by the accept
 * page so it can render the email + expiry before the user submits.
 */
async function validateInvitationToken(token) {
  const invitation = await db('customer_invitations')
    .leftJoin('admin_users', 'admin_users.id', 'customer_invitations.invited_by')
    .where('customer_invitations.token', token)
    .whereNull('customer_invitations.accepted_at')
    .where('customer_invitations.expires_at', '>', new Date())
    .select(
      'customer_invitations.email',
      'customer_invitations.expires_at',
      'customer_invitations.prefill_data',
      'admin_users.username as invited_by_username'
    )
    .first();
  if (!invitation) return null;
  return {
    ...invitation,
    prefill: decodePrefill(invitation.prefill_data),
  };
}

/**
 * Customer roster for the admin Customers page. Includes a count of how
 * many events each customer has access to, so the admin can spot orphaned
 * accounts at a glance.
 */
async function listCustomers({ search } = {}) {
  let q = db('customer_accounts')
    .leftJoin('event_customer_assignments', 'event_customer_assignments.customer_account_id', 'customer_accounts.id')
    .groupBy('customer_accounts.id')
    .select(
      'customer_accounts.id',
      'customer_accounts.email',
      'customer_accounts.display_name',
      'customer_accounts.first_name',
      'customer_accounts.last_name',
      'customer_accounts.salutation',
      'customer_accounts.company_name',
      'customer_accounts.is_active',
      'customer_accounts.last_login',
      'customer_accounts.created_at',
      db.raw('COUNT(event_customer_assignments.id) as event_count')
    )
    .orderBy('customer_accounts.created_at', 'desc');

  if (search && String(search).trim()) {
    const term = `%${String(search).trim().toLowerCase()}%`;
    q = q.where(function () {
      this.whereRaw('LOWER(customer_accounts.email) LIKE ?', [term])
        .orWhereRaw('LOWER(COALESCE(customer_accounts.display_name, \'\')) LIKE ?', [term])
        .orWhereRaw('LOWER(COALESCE(customer_accounts.last_name, \'\')) LIKE ?', [term])
        .orWhereRaw('LOWER(COALESCE(customer_accounts.company_name, \'\')) LIKE ?', [term]);
    });
  }

  return q;
}

/**
 * Single customer record + their event assignments. Used by the admin
 * detail view; the customer's own dashboard uses listEventsForCustomer.
 */
async function getCustomerById(id) {
  const customer = await db('customer_accounts').where('id', id).first();
  if (!customer) {
    throw new NotFoundError('Customer', id);
  }
  const events = await db('event_customer_assignments')
    .join('events', 'events.id', 'event_customer_assignments.event_id')
    .where('event_customer_assignments.customer_account_id', id)
    .select(
      'events.id',
      'events.slug',
      'events.event_name',
      'events.event_date',
      'events.expires_at',
      'events.is_archived',
      'event_customer_assignments.assigned_at'
    )
    .orderBy('event_customer_assignments.assigned_at', 'desc');
  return { ...customer, events };
}

/**
 * Update customer profile. Admins can edit any field except auth-related
 * columns (password_hash, password_changed_at, must_change_password) which
 * are mutated by deactivate / reset / accept paths only.
 *
 * email changes deliberately allowed — the admin may need to correct a
 * typo before the customer accepts. Uniqueness is enforced.
 */
async function updateCustomer(id, updates, updatedByAdminId) {
  const customer = await db('customer_accounts').where('id', id).first();
  if (!customer) {
    throw new NotFoundError('Customer', id);
  }

  const allowed = {};
  const fields = [
    'email', 'salutation', 'first_name', 'last_name', 'display_name',
    'phone', 'company_name', 'billing_email', 'vat_id',
    'address_line1', 'address_line2', 'postal_code', 'city', 'state',
    'country_code', 'preferred_language', 'notes',
    // Per-customer feature flags (#354 follow-up). Booleans below are
    // coerced via formatBoolean for SQLite compatibility.
    'feature_calendar', 'feature_quotes', 'feature_bills',
  ];
  for (const f of fields) {
    if (updates[f] !== undefined) {
      // Trim+lowercase email; everything else passes through. country_code
      // is uppercased to match ISO 3166-1 alpha-2 convention.
      if (f === 'email') {
        allowed[f] = String(updates[f] || '').trim().toLowerCase();
      } else if (f === 'country_code' && updates[f]) {
        allowed[f] = String(updates[f]).trim().toUpperCase().slice(0, 2);
      } else if (f === 'feature_calendar' || f === 'feature_quotes' || f === 'feature_bills') {
        allowed[f] = formatBoolean(updates[f]);
      } else {
        allowed[f] = updates[f];
      }
    }
  }

  if (allowed.email && allowed.email !== customer.email) {
    const conflict = await db('customer_accounts')
      .where('email', allowed.email)
      .whereNot('id', id)
      .first();
    if (conflict) {
      throw new ConflictError('Email already in use', 'email');
    }
  }

  if (updates.is_active !== undefined) {
    allowed.is_active = formatBoolean(updates.is_active);
  }

  allowed.updated_at = new Date();
  await db('customer_accounts').where('id', id).update(allowed);

  await logActivity('customer_updated',
    { customerId: id, fields: Object.keys(allowed) },
    null,
    { type: 'admin', id: updatedByAdminId, name: 'system' }
  );

  return getCustomerById(id);
}

/**
 * Soft-delete: is_active=false. Existing JWTs become invalid because the
 * customerAuth middleware re-checks is_active on every request. Junction
 * rows are kept for audit (event history shows who had access historically).
 */
async function deactivateCustomer(id, deactivatedByAdminId) {
  const customer = await db('customer_accounts').where('id', id).first();
  if (!customer) {
    throw new NotFoundError('Customer', id);
  }

  await db('customer_accounts').where('id', id).update({
    is_active: formatBoolean(false),
    // Bumping password_changed_at invalidates any outstanding tokens
    // immediately — same trick adminAuth uses.
    password_changed_at: new Date(),
    updated_at: new Date(),
  });

  await logActivity('customer_deactivated',
    { customerId: id, email: customer.email },
    null,
    { type: 'admin', id: deactivatedByAdminId, name: 'system' }
  );

  logger.info('Customer deactivated', { customerId: id, deactivatedByAdminId });
}

/**
 * Reactivate a previously-deactivated customer. Restores login (is_active
 * back to true), but does NOT re-grant any historical assignments — those
 * were never removed (deactivate keeps the junction rows for audit), so
 * the customer immediately sees the same galleries they had before.
 */
async function reactivateCustomer(id, reactivatedByAdminId) {
  const customer = await db('customer_accounts').where('id', id).first();
  if (!customer) {
    throw new NotFoundError('Customer', id);
  }
  if (customer.is_active) {
    return; // already active, no-op
  }

  await db('customer_accounts').where('id', id).update({
    is_active: formatBoolean(true),
    // Don't touch password_changed_at — the customer's password (if set)
    // remains valid. They log in with their existing credential.
    updated_at: new Date(),
  });

  await logActivity('customer_reactivated',
    { customerId: id, email: customer.email },
    null,
    { type: 'admin', id: reactivatedByAdminId, name: 'system' }
  );

  logger.info('Customer reactivated', { customerId: id, reactivatedByAdminId });
}

/**
 * GDPR-style erasure: anonymize-in-place rather than hard delete.
 *
 * Why anonymize, not delete?
 *   - `customer_invitations.accepted_customer_id` has no ON DELETE CASCADE
 *     (Postgres default RESTRICT), so a hard delete would fail if the
 *     customer accepted any invitations. Anonymize sidesteps the FK
 *     constraint entirely.
 *   - `event_customer_assignments` and `activity_logs` rows referencing
 *     this customer are part of the gallery's access audit trail. Wiping
 *     them would leave gaps that "who had access to this event" queries
 *     can't recover from.
 *
 * What we do:
 *   - Replace the email with a sentinel `deleted-<id>-<random>@deleted.invalid`
 *     so unique-on-email holds and the address can never collide with a
 *     real customer the admin invites later.
 *   - NULL every PII column (name, phone, company, vat, full address, notes).
 *   - Wipe `password_hash` so credentials can't be reused.
 *   - Set `is_active=false` and bump `password_changed_at` so any
 *     outstanding tokens die immediately.
 *   - Delete pending invitations + reset tokens for this customer.
 *
 * What we keep:
 *   - The customer_accounts row itself (anonymized).
 *   - Their event_customer_assignments rows (with a now-anonymized FK).
 *   - All activity_logs / access_logs (audit trail).
 *
 * Wrapped in a transaction so a partial failure doesn't leave half-erased
 * state.
 */
async function eraseCustomer(id, erasedByAdminId) {
  const customer = await db('customer_accounts').where('id', id).first();
  if (!customer) {
    throw new NotFoundError('Customer', id);
  }

  // Sentinel email — uses the .invalid TLD (RFC 6761) so it can't be
  // a valid deliverable address, even by accident. Includes the id +
  // a random suffix so a re-erase of a different account doesn't
  // collide on the unique index.
  const sentinelEmail = `deleted-${id}-${crypto.randomBytes(4).toString('hex')}@deleted.invalid`;

  await db.transaction(async (trx) => {
    await trx('customer_accounts').where('id', id).update({
      email: sentinelEmail,
      salutation: null,
      first_name: null,
      last_name: null,
      display_name: null,
      phone: null,
      company_name: null,
      billing_email: null,
      vat_id: null,
      address_line1: null,
      address_line2: null,
      postal_code: null,
      city: null,
      state: null,
      country_code: null,
      notes: null,
      password_hash: null,
      is_active: formatBoolean(false),
      must_change_password: formatBoolean(false),
      password_changed_at: new Date(),
      updated_at: new Date(),
    });

    // Drop pending invitations the customer hasn't accepted yet AND any
    // that ARE pointed at this customer (accepted_customer_id) — keep the
    // history columns (email + invited_by + accepted_at) on the
    // already-accepted ones since those reference the now-sentinel email
    // and serve as audit. We just clear the FK pointer.
    await trx('customer_invitations').where('email', customer.email).whereNull('accepted_at').del();
    await trx('customer_invitations').where('accepted_customer_id', id).update({
      // Keep the row, drop the back-pointer so a future hard-delete (if
      // ever added) doesn't FK-block.
      accepted_customer_id: null,
    });

    // Active reset tokens for this customer should be invalidated.
    await trx('customer_password_resets').where('customer_account_id', id).del();
  });

  await logActivity('customer_erased',
    { customerId: id, originalEmail: customer.email },
    null,
    { type: 'admin', id: erasedByAdminId, name: 'system' }
  );

  logger.info('Customer erased (anonymized in place)', { customerId: id, erasedByAdminId });
}

/**
 * Autocomplete for the event-form picker. Returns up to `limit` rows
 * matching the email/name prefix. Active customers only — deactivated
 * accounts shouldn't show up as assignable options.
 */
async function searchCustomers(query, { limit = 10 } = {}) {
  const term = `%${String(query || '').trim().toLowerCase()}%`;
  if (!term || term === '%%') return [];
  return db('customer_accounts')
    .where('is_active', formatBoolean(true))
    .andWhere(function () {
      this.whereRaw('LOWER(email) LIKE ?', [term])
        .orWhereRaw('LOWER(COALESCE(display_name, \'\')) LIKE ?', [term])
        .orWhereRaw('LOWER(COALESCE(last_name, \'\')) LIKE ?', [term])
        .orWhereRaw('LOWER(COALESCE(company_name, \'\')) LIKE ?', [term]);
    })
    .select('id', 'email', 'display_name', 'first_name', 'last_name', 'company_name')
    .orderBy('email', 'asc')
    .limit(limit);
}

// ---- assignments ---------------------------------------------------------

/**
 * Replace the entire assignment set for one event. Used by the admin
 * event create/update endpoints when they receive `customer_account_ids`
 * — diff-and-apply inside one transaction so the event row and its
 * assignments either both update or neither does.
 *
 * `targetCustomerIds` may be empty to clear all assignments.
 */
async function setAssignmentsForEvent(eventId, targetCustomerIds, adminId, trx = db) {
  const wanted = new Set((targetCustomerIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0));
  const existing = await trx('event_customer_assignments')
    .where('event_id', eventId)
    .select('id', 'customer_account_id');
  const existingIds = new Set(existing.map((r) => r.customer_account_id));

  const toAdd = [...wanted].filter((id) => !existingIds.has(id));
  const toRemove = existing.filter((r) => !wanted.has(r.customer_account_id));

  if (toRemove.length > 0) {
    await trx('event_customer_assignments')
      .whereIn('id', toRemove.map((r) => r.id))
      .del();
  }

  if (toAdd.length > 0) {
    // Validate the customers exist + are active before inserting. Cheaper
    // than catching FK errors and gives the admin a clear error message.
    const valid = await trx('customer_accounts')
      .whereIn('id', toAdd)
      .where('is_active', formatBoolean(true))
      .pluck('id');
    const validSet = new Set(valid);
    const ignored = toAdd.filter((id) => !validSet.has(id));
    if (ignored.length > 0) {
      logger.warn('Ignoring inactive/missing customer ids in assignment', {
        eventId, ignored,
      });
    }
    const rows = [...validSet].map((customerId) => ({
      event_id: eventId,
      customer_account_id: customerId,
      assigned_by_admin_id: adminId,
      assigned_at: new Date(),
    }));
    if (rows.length > 0) {
      await trx('event_customer_assignments').insert(rows);
    }
  }

  return { added: toAdd.length, removed: toRemove.length };
}

/**
 * Inverse of setAssignmentsForEvent: replace the full set of events a
 * single customer is assigned to. Backs the "Manage galleries" dialog
 * on the customer detail page — admins pick from every available
 * event and we diff against the existing row set.
 *
 * Returns { added, removed } so the caller can surface a useful toast.
 *
 * `targetEventIds` may be empty to clear every assignment.
 *
 * Access revocation: removing a row from event_customer_assignments
 * is enough on its own — gallery middleware (galleryMiddleware.js)
 * checks for a live assignment whenever it decodes a JWT minted via
 * the customer access-token endpoint (decoded.via === 'customer').
 * No separate revoked_tokens write needed; the customer's next
 * request 401s the moment this transaction commits.
 */
async function setAssignmentsForCustomer(customerId, targetEventIds, adminId, trx = db) {
  const wanted = new Set((targetEventIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0));
  const existing = await trx('event_customer_assignments')
    .where('customer_account_id', customerId)
    .select('id', 'event_id');
  const existingIds = new Set(existing.map((r) => r.event_id));

  const toAdd = [...wanted].filter((id) => !existingIds.has(id));
  const toRemove = existing.filter((r) => !wanted.has(r.event_id));

  if (toRemove.length > 0) {
    await trx('event_customer_assignments')
      .whereIn('id', toRemove.map((r) => r.id))
      .del();
  }

  // Collect the event IDs that actually landed in the DB (i.e. survived
  // the archived/missing filter) so the post-commit notifier knows
  // exactly which galleries to mention in the email. Empty by default.
  let addedEventIds = [];

  if (toAdd.length > 0) {
    // Validate the events exist + are not archived before inserting.
    // Mirrors the customer-side check in setAssignmentsForEvent so an
    // admin can't accidentally pin a customer to an archived event
    // that they couldn't actually open anyway.
    const valid = await trx('events')
      .whereIn('id', toAdd)
      .where('is_archived', formatBoolean(false))
      .pluck('id');
    const validSet = new Set(valid);
    const ignored = toAdd.filter((id) => !validSet.has(id));
    if (ignored.length > 0) {
      logger.warn('Ignoring missing/archived event ids in customer assignment', {
        customerId, ignored,
      });
    }
    const rows = [...validSet].map((eventId) => ({
      event_id: eventId,
      customer_account_id: customerId,
      assigned_by_admin_id: adminId,
      assigned_at: new Date(),
    }));
    if (rows.length > 0) {
      await trx('event_customer_assignments').insert(rows);
      addedEventIds = rows.map((r) => r.event_id);
    }
  }

  // Notify the customer about newly-accessible galleries. Best-effort
  // — a failure here must not roll back the assignment write, so we
  // fire-and-forget after the transactional work is done and swallow
  // any throw with a warn log. Skipped when no new rows were added.
  if (addedEventIds.length > 0) {
    notifyCustomerOfNewAssignments(customerId, addedEventIds).catch((err) => {
      logger.warn('Failed to queue customer_gallery_assigned email', {
        customerId, addedEventIds, error: err?.message,
      });
    });
  }

  return { added: toAdd.length, removed: toRemove.length, addedEventIds };
}

/**
 * Queue a `customer_gallery_assigned` email summarising newly-granted
 * gallery access for one customer. Called by setAssignmentsForCustomer
 * after the transaction commits.
 *
 * Rules:
 *   - One email per save (digest), not one per gallery.
 *   - Archived + expired events are filtered out — the customer would
 *     hit a "this gallery has expired" notice anyway, so naming them
 *     in the email just confuses people.
 *   - Deactivated customers (is_active=false) get no email — their
 *     login is off, so a "you have new access" message would be
 *     misleading.
 *   - Customers without an email on file are skipped (silently —
 *     should never happen for accepted accounts but defensive).
 *   - Email failures are logged but never bubble up; the caller's
 *     `.catch` handler logs again at a more specific call site.
 */
async function notifyCustomerOfNewAssignments(customerId, addedEventIds) {
  if (!addedEventIds || addedEventIds.length === 0) return;

  const customer = await db('customer_accounts')
    .where({ id: customerId, is_active: formatBoolean(true) })
    .select('id', 'email', 'display_name', 'first_name', 'preferred_language')
    .first();
  if (!customer || !customer.email) {
    logger.info('Skip customer_gallery_assigned email: customer missing/inactive/no email', {
      customerId,
    });
    return;
  }

  // Filter the added events to those the customer can actually open.
  // Archived events are hard-skipped; expired ones (expires_at in the
  // past) would render as "Expired DD MMM" in the dashboard and lead
  // to a confusing "I clicked the link in the email and got a 410"
  // experience — drop those too.
  const now = new Date();
  const events = await db('events')
    .whereIn('id', addedEventIds)
    .where('is_archived', formatBoolean(false))
    .andWhere(function() {
      this.whereNull('expires_at').orWhere('expires_at', '>', now);
    })
    .orderBy('event_date', 'desc')
    .select('id', 'slug', 'event_name', 'event_date');

  if (events.length === 0) {
    logger.info('Skip customer_gallery_assigned email: all added events archived/expired', {
      customerId, addedEventIds,
    });
    return;
  }

  // Build the gallery list block. HTML is whitelisted via
  // HTML_PASSTHROUGH_KEYS in emailProcessor so the <ul> survives the
  // body-html escaping pass. Names + dates come from admin-controlled
  // DB rows; the date is server-rendered.
  const { formatDate } = require('../utils/dateFormatter');
  const { escapeHtml } = require('../utils/formatters');
  const language = customer.preferred_language || 'en';

  const formattedRows = await Promise.all(events.map(async (ev) => ({
    name: ev.event_name || ev.slug,
    date: ev.event_date ? await formatDate(ev.event_date, language) : '',
  })));

  const galleryListHtml = `<ul>\n${
    formattedRows.map((r) => {
      const safeName = escapeHtml(r.name);
      const safeDate = r.date ? ` — ${escapeHtml(r.date)}` : '';
      return `  <li>${safeName}${safeDate}</li>`;
    }).join('\n')
  }\n</ul>`;

  const galleryListText = formattedRows
    .map((r) => r.date ? `- ${r.name} (${r.date})` : `- ${r.name}`)
    .join('\n');

  const frontendUrl = (await getFrontendBaseUrl()) || 'http://localhost:3000';
  const customerName = customer.display_name?.trim()
    || customer.first_name?.trim()
    || (customer.email ? customer.email.split('@')[0] : '');

  await queueEmail(null, customer.email, 'customer_gallery_assigned', {
    customer_name: customerName,
    gallery_count: String(events.length),
    // `singular` / `multiple` drive the {{#if}} blocks in the
    // template — safeTemplateReplace treats anything non-empty +
    // non-false as truthy, so passing literal 'true' / '' works.
    singular: events.length === 1 ? 'true' : '',
    multiple: events.length > 1 ? 'true' : '',
    gallery_list_html: galleryListHtml,
    gallery_list_text: galleryListText,
    dashboard_link: `${frontendUrl}/customer/dashboard`,
  });
}

/**
 * Fetch the customers currently assigned to an event. Returned by the
 * admin event-detail endpoint so the picker can hydrate.
 */
async function getAssignmentsForEvent(eventId) {
  return db('event_customer_assignments')
    .join('customer_accounts', 'customer_accounts.id', 'event_customer_assignments.customer_account_id')
    .where('event_customer_assignments.event_id', eventId)
    .select(
      'customer_accounts.id',
      'customer_accounts.email',
      'customer_accounts.display_name',
      'customer_accounts.first_name',
      'customer_accounts.last_name',
      'customer_accounts.is_active'
    )
    .orderBy('customer_accounts.email', 'asc');
}

/**
 * Events visible to a logged-in customer. Filters out archived events
 * since those galleries are no longer browsable. Expired events are
 * deliberately included so customers can see "your gallery has expired"
 * messaging in the dashboard rather than just disappearing silently.
 *
 * is_draft filter intentionally NOT applied: a customer assigned to a
 * draft gallery should still see it on their dashboard (the photographer
 * may want them to preview before publish). is_archived stays as the
 * single hard-exclude — those galleries are gone.
 *
 * is_archived has a NOT NULL DEFAULT false from migration 029, so a
 * plain typed filter is safe — no need for a COALESCE-via-whereRaw
 * dance (which itself caused a 500 on postgres because the parameter
 * placeholders weren't accepting the boolean cleanly).
 */
async function listEventsForCustomer(customerId) {
  return db('event_customer_assignments')
    .join('events', 'events.id', 'event_customer_assignments.event_id')
    .where('event_customer_assignments.customer_account_id', customerId)
    .where('events.is_archived', formatBoolean(false))
    .select(
      'events.id',
      'events.slug',
      'events.event_name',
      'events.event_type',
      'events.event_date',
      'events.expires_at',
      'events.is_active',
      'event_customer_assignments.assigned_at'
    )
    .orderBy('events.event_date', 'desc');
}

/**
 * True iff this customer is assigned to this event. Used by the
 * access-token exchange endpoint in customer.js to decide whether to
 * mint a gallery token.
 */
async function customerHasAccessToEvent(customerId, eventId) {
  const row = await db('event_customer_assignments')
    .where('customer_account_id', customerId)
    .where('event_id', eventId)
    .first('id');
  return !!row;
}

// ---- pending invitations -----------------------------------------------

async function getPendingInvitations() {
  return db('customer_invitations')
    .leftJoin('admin_users', 'admin_users.id', 'customer_invitations.invited_by')
    .whereNull('customer_invitations.accepted_at')
    .where('customer_invitations.expires_at', '>', new Date())
    .select(
      'customer_invitations.id',
      'customer_invitations.email',
      'customer_invitations.expires_at',
      'customer_invitations.created_at',
      'admin_users.username as invited_by'
    )
    .orderBy('customer_invitations.created_at', 'desc');
}

async function cancelInvitation(id, cancelledByAdminId) {
  const invitation = await db('customer_invitations').where('id', id).first();
  if (!invitation) {
    throw new NotFoundError('Invitation', id);
  }
  await db('customer_invitations').where('id', id).del();

  await logActivity('customer_invitation_cancelled',
    { invitationId: id, email: invitation.email },
    null,
    { type: 'admin', id: cancelledByAdminId, name: 'system' }
  );
  logger.info('Customer invitation cancelled', { invitationId: id, cancelledByAdminId });
}

// =====================================================================
// Customer-surface global toggles + password resets (#354 follow-up)
// =====================================================================

const PASSWORD_RESET_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
/**
 * Read the master "Customer portal" feature flag (#354). When false,
 * every customer-side surface (login, dashboard, accept-invite, reset)
 * returns 403/410 and the admin "Customers" sidebar entry is hidden.
 *
 * Reads from the maintainer's `feature_flags` table (migration 088).
 * Defaults to false on installs missing the row (e.g. migration 095
 * hasn't run yet).
 */
async function isCustomerPortalEnabled() {
  try {
    if (!(await db.schema.hasTable('feature_flags'))) return false;
    const row = await db('feature_flags').where({ key: 'customerPortal' }).first();
    if (!row) return false;
    const v = row.value;
    return v === true || v === 1 || v === '1' || v === 'true';
  } catch (e) {
    // Defensive: if feature_flags is briefly unavailable (early bootstrap,
    // failover) treat as off rather than throwing a 500 from the gate.
    return false;
  }
}

/**
 * Customer-surface global toggles. Branding visibility (logo /
 * company name in the customer dashboard header) lives in
 * app_settings under setting_type='customer_surface' and is edited
 * from the Branding page (Customer dashboard card, gated by the
 * customerPortal feature flag).
 *
 * Calendar / Quotes / Bills feature globals are intentionally OFF
 * here — those surfaces are now governed by the maintainer's
 * feature_flags table (Settings → Features), not by app_settings.
 *
 * Returns sane defaults when the keys aren't present so an install
 * missing migration 092 doesn't crash — branding defaults ON to
 * match the visual state before the toggle existed.
 */
async function getCustomerSurfaceGlobals() {
  const rows = await db('app_settings').where('setting_type', 'customer_surface').select('setting_key', 'setting_value');
  const map = {};
  for (const r of rows) {
    let v = r.setting_value;
    if (typeof v === 'string') {
      try { v = JSON.parse(v); } catch { /* leave as-is */ }
    }
    map[r.setting_key] = v;
  }
  return {
    calendarEnabled: false,
    quotesEnabled: false,
    billsEnabled: false,
    showLogo:        map.customer_show_logo !== false, // default true
    showCompanyName: map.customer_show_company_name !== false, // default true
  };
}

/**
 * Compute the effective feature-flag set for a single customer.
 *
 * AND-logic: a customer sees a feature iff the global toggle is on AND
 * their per-customer flag is on. This gives the admin two independent
 * levers — flip a feature on for the whole instance, then choose which
 * customers actually see it.
 *
 * Pass either a numeric customerId (we'll fetch) or a row already loaded.
 */
async function getEffectiveFeaturesForCustomer(customerOrId) {
  const customer = (typeof customerOrId === 'number')
    ? await db('customer_accounts').where('id', customerOrId).first()
    : customerOrId;
  if (!customer) {
    return { calendar: false, quotes: false, bills: false };
  }
  const globals = await getCustomerSurfaceGlobals();
  return {
    calendar: globals.calendarEnabled && customer.feature_calendar === true,
    quotes:   globals.quotesEnabled   && customer.feature_quotes   === true,
    bills:    globals.billsEnabled    && customer.feature_bills    === true,
  };
}

/**
 * Admin triggers a password reset for an existing customer.
 *
 * Behaviour:
 *   - Generates a 64-char hex token (matches invitation tokens).
 *   - Stores it in customer_password_resets with a 7-day expiry.
 *   - Queues a customer_password_reset email with the link.
 *   - Does NOT invalidate the existing password yet — we only flip
 *     password_changed_at on the actual reset (so a typo'd reset doesn't
 *     lock a customer out of an already-working session).
 *
 * Idempotency: if there's an unused, non-expired reset already in flight
 * we delete it before creating the new one — admins re-clicking the
 * "Send reset" button shouldn't fan out two valid links.
 */
async function createPasswordReset({ customerId, requestedByAdminId }) {
  const customer = await db('customer_accounts').where('id', customerId).first();
  if (!customer) {
    throw new NotFoundError('Customer', customerId);
  }
  if (!customer.is_active) {
    throw new ValidationError('Cannot reset password for an inactive customer');
  }

  // Clean up any previous unused reset for this customer.
  await db('customer_password_resets')
    .where('customer_account_id', customerId)
    .whereNull('used_at')
    .del();

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);

  await db('customer_password_resets').insert({
    token,
    customer_account_id: customerId,
    requested_by_admin_id: requestedByAdminId || null,
    expires_at: expiresAt,
    created_at: new Date(),
  });

  const frontendUrl = (await getFrontendBaseUrl()) || 'http://localhost:3000';
  await queueEmail(null, customer.email, 'customer_password_reset', {
    reset_link: `${frontendUrl}/customer/reset-password/${token}`,
    expires_at: expiresAt.toISOString(),
  });

  await logActivity('customer_password_reset_requested',
    { customerId, email: customer.email },
    null,
    { type: 'admin', id: requestedByAdminId, name: 'system' }
  );

  logger.info('Customer password reset requested', { customerId, requestedByAdminId });
  return { customerId, email: customer.email, expiresAt };
}

/**
 * Validate a password-reset token (lookup-only — does NOT consume it).
 * Used by the customer's reset page to render "you're resetting the
 * password for X" before they submit.
 */
async function validatePasswordResetToken(token) {
  const row = await db('customer_password_resets')
    .join('customer_accounts', 'customer_accounts.id', 'customer_password_resets.customer_account_id')
    .where('customer_password_resets.token', token)
    .whereNull('customer_password_resets.used_at')
    .where('customer_password_resets.expires_at', '>', new Date())
    .where('customer_accounts.is_active', formatBoolean(true))
    .select(
      'customer_password_resets.id',
      'customer_password_resets.customer_account_id',
      'customer_password_resets.expires_at',
      'customer_accounts.email',
    )
    .first();
  return row || null;
}

/**
 * Apply a password reset: hash the new password, write it onto the
 * customer row, mark the reset row used, and bump password_changed_at
 * so any tokens issued before the reset (e.g. an attacker's session)
 * stop working on next request.
 *
 * Wrapped in a transaction so we can't end up with a used token but no
 * password update, or vice versa.
 */
async function applyPasswordReset({ token, password }) {
  const row = await db('customer_password_resets')
    .where('token', token)
    .whereNull('used_at')
    .where('expires_at', '>', new Date())
    .first();
  if (!row) {
    throw new ValidationError('Invalid or expired reset link');
  }

  const customer = await db('customer_accounts').where('id', row.customer_account_id).first();
  if (!customer || !customer.is_active) {
    throw new ValidationError('Invalid or expired reset link');
  }

  const passwordHash = await bcrypt.hash(password, getBcryptRounds());
  await db.transaction(async (trx) => {
    await trx('customer_accounts').where('id', customer.id).update({
      password_hash: passwordHash,
      password_changed_at: new Date(),
      must_change_password: formatBoolean(false),
      updated_at: new Date(),
    });
    await trx('customer_password_resets').where('id', row.id).update({ used_at: new Date() });
  });

  await logActivity('customer_password_reset_applied',
    { customerId: customer.id, email: customer.email },
    null,
    { type: 'system', id: null, name: 'system' }
  );

  logger.info('Customer password reset applied', { customerId: customer.id });
  return { email: customer.email };
}

module.exports = {
  createInvitation,
  acceptInvitation,
  validateInvitationToken,
  listCustomers,
  getCustomerById,
  updateCustomer,
  deactivateCustomer,
  reactivateCustomer,
  eraseCustomer,
  searchCustomers,
  setAssignmentsForEvent,
  setAssignmentsForCustomer,
  getAssignmentsForEvent,
  listEventsForCustomer,
  customerHasAccessToEvent,
  getPendingInvitations,
  cancelInvitation,
  // #354 follow-up
  isCustomerPortalEnabled,
  getCustomerSurfaceGlobals,
  getEffectiveFeaturesForCustomer,
  createPasswordReset,
  validatePasswordResetToken,
  applyPasswordReset,
};
