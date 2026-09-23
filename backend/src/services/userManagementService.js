/**
 * User Management Service for Admin Users
 * Handles invitations, user CRUD, and role management
 */

const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { db, logActivity } = require('../database/db');
const { deleteWithAccountingHistory } = require('./accountingHistory');
const { formatBoolean } = require('../utils/dbCompat');
const { generateSecurePassword } = require('../utils/passwordGenerator');
const { getBcryptRounds } = require('../utils/passwordValidation');
const { getAbsoluteFrontendUrl } = require('../utils/frontendUrl');
const { queueEmail } = require('./emailProcessor');
const logger = require('../utils/logger');
const { ConflictError, NotFoundError, ValidationError, ForbiddenError } = require('../utils/errors');
const { hasColumnCached } = require('../utils/schemaCache');

/**
 * Create a new admin user invitation
 * @param {object} params - { email, roleId, invitedById }
 * @returns {Promise<object>} Created invitation details
 */
async function createInvitation({ email, roleId, invitedById, inviterRoleName }) {
  // Check if email already exists — without case, so an invite cannot create
  // a second row that a lowercased IdP claim would also match.
  const existingUser = await db('admin_users')
    .whereRaw('LOWER(email) = ?', [String(email).toLowerCase()])
    .first();
  if (existingUser) {
    throw new ConflictError('User with this email already exists', 'email');
  }

  // Check for pending invitation. Exact-case on purpose: two case-variant
  // invitations may both be pending, and whichever is accepted second is
  // refused by the LOWER(email) check in acceptInvitation, so no second
  // admin row can come out of it.
  const pendingInvite = await db('admin_invitations')
    .where('email', email)
    .whereNull('accepted_at')
    .where('expires_at', '>', new Date())
    .first();

  if (pendingInvite) {
    throw new ConflictError('Pending invitation already exists for this email', 'email');
  }

  // Validate role exists
  const role = await db('roles').where('id', roleId).first();
  if (!role) {
    throw new NotFoundError('Role', roleId);
  }

  // Role hierarchy: only super_admin can invite super_admin
  if (role.name === 'super_admin' && inviterRoleName !== 'super_admin') {
    throw new ValidationError('Only Super Admins can invite new Super Admins');
  }

  // Privilege-escalation guard (GHSA-rv8w-m6mx-7j4q): holding `users.create`
  // must not let an actor invite someone into a role carrying permissions
  // they don't themselves have — same containment updateAdminUser already
  // gives role assignment, reused here for invitations.
  const targetRolePermissions = await db('role_permissions')
    .join('permissions', 'permissions.id', 'role_permissions.permission_id')
    .where('role_permissions.role_id', role.id)
    .pluck('permissions.name');
  await assertActorMayGrant(invitedById, targetRolePermissions);

  // Generate secure invitation token (64 characters hex = 32 bytes)
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  const [invitationId] = await db('admin_invitations').insert({
    email,
    token,
    role_id: roleId,
    invited_by: invitedById,
    expires_at: expiresAt,
    created_at: new Date()
  }).returning('id');

  const id = invitationId?.id || invitationId;

  // Queue invitation email
  // Keeps the original FRONTEND_URL-before-ADMIN_URL order: ADMIN_URL is the
  // resolver's override, so a split-origin install that points it at a
  // separate admin host still wins over the general_site_url setting - it
  // must not sit AFTER the resolver, which only returns falsy when nothing at
  // all is configured (#1104). Only the terminal fallback changes, from
  // localhost:3005 - not even the frontend's port, so an unconfigured install
  // mailed admin invites pointing nowhere - to the resolved origin (#705).
  const frontendUrl = await getAbsoluteFrontendUrl(null, { override: process.env.ADMIN_URL });
  await queueEmail(null, email, 'admin_invitation', {
    invite_link: `${frontendUrl}/invite/${token}`,
    role_name: role.display_name,
    expires_at: expiresAt.toISOString()
  });

  await logActivity('admin_invitation_created',
    { email, roleId, roleName: role.display_name },
    null,
    { type: 'admin', id: invitedById, name: 'system' }
  );

  logger.info('Admin invitation created', { email, roleId, invitedById });

  return { id, email, token, role: role.display_name, expiresAt };
}

/**
 * Accept an invitation and create the admin user
 * @param {object} params - { token, username, password }
 * @returns {Promise<object>} Created user details
 */
async function acceptInvitation({ token, username, password }) {
  const invitation = await db('admin_invitations')
    .where('token', token)
    .whereNull('accepted_at')
    .where('expires_at', '>', new Date())
    .first();

  if (!invitation) {
    throw new ValidationError('Invalid or expired invitation');
  }

  // Check username availability
  const existingUsername = await db('admin_users').where('username', username).first();
  if (existingUsername) {
    throw new ConflictError('Username already taken', 'username');
  }

  // Check email not taken (race condition protection), without case
  const existingEmail = await db('admin_users')
    .whereRaw('LOWER(email) = ?', [String(invitation.email).toLowerCase()])
    .first();
  if (existingEmail) {
    throw new ConflictError('Email already registered', 'email');
  }

  // Hash password
  const passwordHash = await bcrypt.hash(password, getBcryptRounds());

  // Create user in transaction
  const result = await db.transaction(async (trx) => {
    const [userId] = await trx('admin_users').insert({
      username,
      email: invitation.email,
      password_hash: passwordHash,
      role_id: invitation.role_id,
      created_by: invitation.invited_by,
      is_active: formatBoolean(true),
      must_change_password: formatBoolean(false),
      invite_accepted_at: new Date(),
      created_at: new Date(),
      updated_at: new Date()
    }).returning('id');

    const id = userId?.id || userId;

    // Mark invitation as accepted
    await trx('admin_invitations')
      .where('id', invitation.id)
      .update({
        accepted_at: new Date(),
        accepted_user_id: id
      });

    return id;
  });

  await logActivity('admin_invitation_accepted',
    { userId: result, email: invitation.email },
    null,
    { type: 'system', id: null, name: 'system' }
  );

  logger.info('Admin invitation accepted', {
    userId: result,
    email: invitation.email,
    invitationId: invitation.id
  });

  return { userId: result, email: invitation.email };
}

/**
 * Get all admin users with their roles
 * @returns {Promise<object[]>}
 */
async function getAllAdminUsers() {
  const columns = [
    'admin_users.id',
    'admin_users.username',
    'admin_users.email',
    'admin_users.is_active',
    'admin_users.last_login',
    'admin_users.last_login_ip',
    'admin_users.created_at',
    'admin_users.updated_at',
    'roles.id as role_id',
    'roles.name as role_name',
    'roles.display_name as role_display_name',
    'creator.username as created_by_username'
  ];
  // The Users page offers "confirm this email for SSO" on the rows this is
  // false for, so it has to travel with the list (migration 227).
  if (await hasColumnCached('admin_users', 'email_link_eligible')) {
    columns.push('admin_users.email_link_eligible');
  }
  return db('admin_users')
    .leftJoin('roles', 'roles.id', 'admin_users.role_id')
    .leftJoin('admin_users as creator', 'creator.id', 'admin_users.created_by')
    .select(columns)
    .orderBy('admin_users.created_at', 'desc');
}

/**
 * Get single admin user by ID
 * @param {number} id - User ID
 * @returns {Promise<object>}
 */
async function getAdminUserById(id) {
  const columns = [
    'admin_users.id',
    'admin_users.username',
    'admin_users.email',
    'admin_users.is_active',
    'admin_users.last_login',
    'admin_users.last_login_ip',
    'admin_users.created_at',
    'admin_users.updated_at',
    'roles.id as role_id',
    'roles.name as role_name',
    'roles.display_name as role_display_name'
  ];
  if (await hasColumnCached('admin_users', 'email_link_eligible')) {
    columns.push('admin_users.email_link_eligible');
  }
  const user = await db('admin_users')
    .leftJoin('roles', 'roles.id', 'admin_users.role_id')
    .where('admin_users.id', id)
    .select(columns)
    .first();

  if (!user) {
    throw new NotFoundError('Admin user', id);
  }

  return user;
}

/**
 * Update admin user
 * @param {number} id - User ID to update
 * @param {object} updates - Fields to update
 * @param {number} updatedById - ID of user making the update
 * @returns {Promise<object>} Updated user
 */
async function updateAdminUser(id, updates, updatedById, requestingAdmin = {}) {
  // Account status has dedicated activate/deactivate operations with a
  // stronger permission and self/last-super-admin safeguards. Reject the
  // field before applying any part of a mixed profile update.
  if (Object.prototype.hasOwnProperty.call(updates, 'is_active')) {
    throw new ValidationError('Use the activate or deactivate action to change account status');
  }
  const user = await db('admin_users').where('id', id).first();
  if (!user) {
    throw new NotFoundError('Admin user', id);
  }

  const allowedUpdates = {};
  let confirmedAddress = null;

  // Only a super_admin may change a super_admin account. users.edit is a
  // delegable permission; without this a holder could rewrite a super_admin's
  // username or email, which the dedicated routes (reset-password, role
  // assignment, invitations) already refuse.
  const superAdminRole = await db('roles').where('name', 'super_admin').first();
  const actorIsSuperAdmin = requestingAdmin.roleName === 'super_admin';
  const targetIsSuperAdmin = Boolean(superAdminRole && user.role_id === superAdminRole.id);
  if (targetIsSuperAdmin && !actorIsSuperAdmin) {
    throw new ForbiddenError('Only Super Admins can modify a Super Admin account');
  }

  if (updates.username !== undefined) {
    const existing = await db('admin_users')
      .where('username', updates.username)
      .whereNot('id', id)
      .first();
    if (existing) {
      throw new ConflictError('Username already taken', 'username');
    }
    allowedUpdates.username = updates.username;
  }

  if (updates.email !== undefined) {
    // Without case, like the OIDC lookup: an existing Mara@Example.com must
    // not let a second admin take mara@example.com.
    const existing = await db('admin_users')
      .whereRaw('LOWER(email) = ?', [String(updates.email).toLowerCase()])
      .whereNot('id', id)
      .first();
    if (existing) {
      throw new ConflictError('Email already in use', 'email');
    }
    // The route lowercases what it receives (normalizeEmail keeps
    // all_lowercase), so re-saving a mixed-case address would rewrite the
    // stored one. Confirming an address must not edit it — compare without
    // case and leave the column alone when it is the same address.
    const sameAddress = String(updates.email).toLowerCase() === String(user.email || '').toLowerCase();
    if (!sameAddress) {
      allowedUpdates.email = updates.email;
    } else {
      // Confirming trusts the address as it was read at the top of this
      // function, and writes no address of its own. The target can change
      // their own email through PUT /admin/profile in between (which sets
      // eligibility false); the write below must then not land on that new,
      // unapproved address.
      confirmedAddress = user.email;
    }
    // Whether a later SSO login may link to this account by email
    // (oidcService, migration 227): an address set by a super_admin is
    // trusted — saving it unchanged is how a super_admin confirms one — while
    // a change by anyone else is not proof of ownership.
    if (await hasColumnCached('admin_users', 'email_link_eligible')) {
      if (actorIsSuperAdmin) {
        allowedUpdates.email_link_eligible = formatBoolean(true);
      } else if (!sameAddress) {
        allowedUpdates.email_link_eligible = formatBoolean(false);
      }
    }
  }

  if (updates.role_id !== undefined) {
    const role = await db('roles').where('id', updates.role_id).first();
    if (!role) {
      throw new NotFoundError('Role', updates.role_id);
    }

    // Only super_admin can assign super_admin role
    if (superAdminRole && role.id === superAdminRole.id && !actorIsSuperAdmin) {
      throw new ValidationError('Only Super Admins can assign the Super Admin role');
    }

    // Privilege-escalation guard (GHSA-rv8w-m6mx-7j4q): holding `users.edit`
    // must not let an actor hand out a role carrying permissions they don't
    // themselves have — same containment assertActorMayGrant already gives
    // `roles.manage` for role create/edit, reused here for role assignment.
    const targetRolePermissions = await db('role_permissions')
      .join('permissions', 'permissions.id', 'role_permissions.permission_id')
      .where('role_permissions.role_id', role.id)
      .pluck('permissions.name');
    await assertActorMayGrant(updatedById, targetRolePermissions);

    // Prevent self-role-update
    if (id === updatedById) {
      throw new ValidationError('Cannot change your own role');
    }

    // Prevent downgrading the last super_admin
    if (superAdminRole && user.role_id === superAdminRole.id && role.id !== superAdminRole.id) {
      const superAdminCount = await db('admin_users')
        .where('role_id', superAdminRole.id)
        .where('is_active', formatBoolean(true))
        .count('id as count')
        .first();

      if (Number(superAdminCount?.count) <= 1) {
        throw new ValidationError('Cannot demote the last Super Admin');
      }
    }

    allowedUpdates.role_id = updates.role_id;
  }

  allowedUpdates.updated_at = new Date();

  const write = db('admin_users').where('id', id);
  if (confirmedAddress !== null) write.where('email', confirmedAddress);
  const written = await write.update(allowedUpdates);
  if (confirmedAddress !== null && written !== 1) {
    throw new ConflictError('The email address changed while this was open — reload and try again', 'email');
  }

  await logActivity('admin_user_updated',
    { userId: id, changes: Object.keys(allowedUpdates) },
    null,
    { type: 'admin', id: updatedById, name: 'system' }
  );

  return getAdminUserById(id);
}

/**
 * Only a super_admin may change a super_admin account (deactivate, activate,
 * delete). users.delete is delegable; the dedicated routes for invitations,
 * role assignment and password resets already hold the same line.
 */
async function assertMayManageSuperAdminTarget(target, actorId) {
  const superAdminRole = await db('roles').where('name', 'super_admin').first();
  if (!superAdminRole || target.role_id !== superAdminRole.id) return;
  const actor = await db('admin_users')
    .leftJoin('roles', 'roles.id', 'admin_users.role_id')
    .where('admin_users.id', actorId)
    .first('roles.name as role_name');
  if (!actor || actor.role_name !== 'super_admin') {
    throw new ForbiddenError('Only Super Admins can modify a Super Admin account');
  }
}

/**
 * Deactivate admin user
 * @param {number} id - User ID to deactivate
 * @param {number} deactivatedById - ID of user performing deactivation
 */
async function deactivateAdminUser(id, deactivatedById) {
  const user = await db('admin_users').where('id', id).first();
  if (!user) {
    throw new NotFoundError('Admin user', id);
  }

  // Prevent self-deactivation
  if (id === deactivatedById) {
    throw new ValidationError('Cannot deactivate your own account');
  }

  // Check if this is the last super_admin
  const superAdminRole = await db('roles').where('name', 'super_admin').first();
  if (user.role_id === superAdminRole?.id) {
    const superAdminCount = await db('admin_users')
      .where('role_id', superAdminRole.id)
      .where('is_active', formatBoolean(true))
      .count('id as count')
      .first();

    if (Number(superAdminCount?.count) <= 1) {
      throw new ValidationError('Cannot deactivate the last Super Admin');
    }
  }

  // After the invariants above, which hold for every caller including a
  // super_admin, so their specific message survives.
  await assertMayManageSuperAdminTarget(user, deactivatedById);

  await db('admin_users').where('id', id).update({
    is_active: formatBoolean(false),
    updated_at: new Date()
  });

  await logActivity('admin_user_deactivated',
    { userId: id, username: user.username },
    null,
    { type: 'admin', id: deactivatedById, name: 'system' }
  );

  logger.info('Admin user deactivated', { userId: id, deactivatedById });
}

/**
 * Re-activate a previously deactivated admin user. Symmetric counterpart
 * to deactivateAdminUser — flips is_active back to true so the account
 * can log in again.
 *
 * Reported in #574 follow-up: once an admin was deactivated, the UI
 * lost the only affordance to manage that record (no Reactivate, no
 * Delete). This is the Reactivate half.
 *
 * @param {number} id - User ID to activate
 * @param {number} activatedById - ID of the admin performing the action
 */
async function activateAdminUser(id, activatedById) {
  const user = await db('admin_users').where('id', id).first();
  if (!user) {
    throw new NotFoundError('Admin user', id);
  }
  await assertMayManageSuperAdminTarget(user, activatedById);

  // No "last super admin" guard needed — activate only ever ADDS an
  // active super_admin, never removes one. No "can't activate
  // yourself" guard either — by definition the actor is already
  // logged in and active, so this can never be a self-activation.

  if (user.is_active === true || user.is_active === 1) {
    // Already active — short-circuit so the caller's UI doesn't have
    // to special-case "no change" responses.
    return;
  }

  await db('admin_users').where('id', id).update({
    is_active: formatBoolean(true),
    updated_at: new Date()
  });

  await logActivity('admin_user_activated',
    { userId: id, username: user.username },
    null,
    { type: 'admin', id: activatedById, name: 'system' }
  );

  logger.info('Admin user activated', { userId: id, activatedById });
}

/**
 * Permanently delete an admin user from the database. Use only on
 * already-deactivated accounts (the UI nudges admins toward this
 * order). All FK references to admin_users use ON DELETE SET NULL
 * (created_by, recorded_by_admin_id, etc.) or ON DELETE CASCADE
 * (api_tokens, pending invitations) — see migration audit in the
 * #574-follow-up PR description for the full list.
 *
 * @param {number} id - User ID to delete
 * @param {number} deletedById - ID of the admin performing the deletion
 */
async function deleteAdminUser(id, deletedById) {
  const user = await db('admin_users').where('id', id).first();
  if (!user) {
    throw new NotFoundError('Admin user', id);
  }

  // Self-delete would lock the actor out of their own session at the
  // moment of commit. Refuse — same shape as the deactivate guard.
  if (id === deletedById) {
    throw new ValidationError('Cannot delete your own account');
  }

  // Last-super-admin guard — same logic as deactivate. Even if the
  // target is currently is_active=false, deleting them would close
  // the door on a super_admin role recovery (they could otherwise
  // be reactivated). Counts ACTIVE super_admins so a deactivated
  // user being deleted while one active super_admin exists is fine.
  const superAdminRole = await db('roles').where('name', 'super_admin').first();
  if (user.role_id === superAdminRole?.id) {
    const activeSuperAdminCount = await db('admin_users')
      .where('role_id', superAdminRole.id)
      .where('is_active', formatBoolean(true))
      .whereNot('id', id)
      .count('id as count')
      .first();

    if (Number(activeSuperAdminCount?.count) < 1) {
      throw new ValidationError('Cannot delete the last Super Admin');
    }
  }

  // After the invariants above, which hold for every caller including a
  // super_admin, so their specific message survives.
  await assertMayManageSuperAdminTarget(user, deletedById);

  // Hard delete. FK ON DELETE rules in core migrations handle cascade:
  //   SET NULL on created_by_admin_id everywhere (events, photos,
  //     quotes, invoices, contracts, etc.)
  //   CASCADE on api_tokens.user_id, admin_invitations.invited_by,
  //     customer_invitations.invited_by (drops pending tokens + invites
  //     this user issued)
  await deleteWithAccountingHistory(db, 'admin_users', { id },
    { actor: deletedById, source: 'admin_user.delete' });

  await logActivity('admin_user_deleted',
    { userId: id, username: user.username, email: user.email },
    null,
    { type: 'admin', id: deletedById, name: 'system' }
  );

  logger.info('Admin user deleted', { userId: id, deletedById });
}

/**
 * Reset admin user password (generates new password)
 * @param {number} id - User ID
 * @param {number} resetById - ID of user performing reset
 * @returns {Promise<object>} Result with email and status
 */
async function resetAdminPassword(id, resetById) {
  const user = await db('admin_users').where('id', id).first();
  if (!user) {
    throw new NotFoundError('Admin user', id);
  }

  // OIDC-owned accounts (#798) have no usable local password by design —
  // minting one here would hand out a login that bypasses the IdP's MFA
  // and access policies.
  if (user.auth_provider === 'oidc') {
    throw new ValidationError('This account is managed by your identity provider (SSO) — reset the password there.');
  }

  // GHSA-h4w8-57xq-53fx: this password is emailed to the admin and is a live
  // credential until they change it, so it needs real entropy — not the
  // ~2^21 wordlist-based generateReadablePassword() used for gallery resets.
  const newPassword = generateSecurePassword(16);
  const passwordHash = await bcrypt.hash(newPassword, getBcryptRounds());

  // Recovery invalidates every existing API credential permanently, even
  // after the owner completes the required interactive password change.
  await require('./adminPasswordReset').setAdminPasswordForReset(id, passwordHash);

  // Queue password reset email
  await queueEmail(null, user.email, 'admin_password_reset', {
    username: user.username,
    new_password: newPassword
  });

  await logActivity('admin_password_reset',
    { userId: id, username: user.username },
    null,
    { type: 'admin', id: resetById, name: 'system' }
  );

  logger.info('Admin password reset', { userId: id, resetById });

  return { email: user.email, passwordSent: true };
}

/**
 * Get all roles
 * @returns {Promise<object[]>}
 */
async function getAllRoles() {
  return db('roles')
    .select('id', 'name', 'display_name', 'description', 'is_system', 'priority')
    .orderBy('priority', 'desc');
}

/**
 * Get pending invitations
 * @returns {Promise<object[]>}
 */
async function getPendingInvitations() {
  return db('admin_invitations')
    .join('roles', 'roles.id', 'admin_invitations.role_id')
    .join('admin_users', 'admin_users.id', 'admin_invitations.invited_by')
    .whereNull('admin_invitations.accepted_at')
    .where('admin_invitations.expires_at', '>', new Date())
    .select(
      'admin_invitations.id',
      'admin_invitations.email',
      'admin_invitations.expires_at',
      'admin_invitations.created_at',
      'roles.display_name as role_name',
      'admin_users.username as invited_by'
    )
    .orderBy('admin_invitations.created_at', 'desc');
}

/**
 * Cancel/delete an invitation
 * @param {number} id - Invitation ID
 * @param {number} cancelledById - ID of user cancelling
 */
async function cancelInvitation(id, cancelledById) {
  const invitation = await db('admin_invitations').where('id', id).first();
  if (!invitation) {
    throw new NotFoundError('Invitation', id);
  }

  await db('admin_invitations').where('id', id).del();

  await logActivity('admin_invitation_cancelled',
    { invitationId: id, email: invitation.email },
    null,
    { type: 'admin', id: cancelledById, name: 'system' }
  );

  logger.info('Admin invitation cancelled', { invitationId: id, cancelledById });
}

/**
 * Validate an invitation token
 * @param {string} token - Invitation token
 * @returns {Promise<object|null>} Invitation details if valid
 */
async function validateInvitationToken(token) {
  const invitation = await db('admin_invitations')
    .join('roles', 'roles.id', 'admin_invitations.role_id')
    .where('admin_invitations.token', token)
    .whereNull('admin_invitations.accepted_at')
    .where('admin_invitations.expires_at', '>', new Date())
    .select(
      'admin_invitations.email',
      'admin_invitations.expires_at',
      'roles.display_name as role_name'
    )
    .first();

  return invitation || null;
}

// ---------------------------------------------------------------------------
// Role management (the role editor). Highly privileged — every mutation here is
// gated by `roles.manage` at the route layer. See project_permission_gating.
// ---------------------------------------------------------------------------

// System roles that ship with the app. Their `name` (the semantic key routes
// check) is immutable and they cannot be deleted; their display/description and
// (except super_admin) their permission set may be tweaked.
const RESERVED_ROLE_NAMES = ['super_admin', 'admin', 'editor', 'viewer', 'solo_photographer', 'team_photographer'];

function clearPermCache() {
  // Bust the RBAC middleware cache so grant changes take effect immediately
  // rather than waiting out its 60s TTL. Lazy-required to avoid a load cycle.
  try { require('../middleware/permissions').clearPermissionCache(); } catch (_) { /* optional */ }
}

function normalizeRoleName(name) {
  return String(name || '').trim().toLowerCase();
}

async function resolvePermissionIds(permissionNames) {
  const names = Array.from(new Set((permissionNames || []).filter(Boolean)));
  if (names.length === 0) return [];
  const rows = await db('permissions').whereIn('name', names).select('id', 'name');
  const found = new Set(rows.map((r) => r.name));
  const missing = names.filter((n) => !found.has(n));
  if (missing.length > 0) {
    throw new ValidationError(`Unknown permission(s): ${missing.join(', ')}`);
  }
  return rows.map((r) => r.id);
}

// Contain the roles.manage blast radius (delegation, not root escalation): a
// non-super_admin managing roles may only grant permissions their OWN role
// already holds, so `roles.manage` can't be turned into "grant myself
// everything". super_admin bypasses (it holds the full catalog anyway).
async function assertActorMayGrant(actorId, permissionNames) {
  const names = Array.from(new Set((permissionNames || []).filter(Boolean)));
  if (names.length === 0) return;
  const actor = await db('admin_users')
    .leftJoin('roles', 'roles.id', 'admin_users.role_id')
    .where('admin_users.id', actorId)
    .select('roles.name as role_name')
    .first();
  if (actor && actor.role_name === 'super_admin') return;
  const { userHasAllPermissions } = require('../middleware/permissions');
  if (!(await userHasAllPermissions(actorId, names))) {
    throw new ForbiddenError('You can only grant permissions your own role already holds.');
  }
}

async function getRoleWithPermissionsById(id) {
  const role = await db('roles')
    .where('id', id)
    .select('id', 'name', 'display_name', 'description', 'is_system', 'priority')
    .first();
  if (!role) return null;
  const permissions = await db('role_permissions')
    .join('permissions', 'permissions.id', 'role_permissions.permission_id')
    .where('role_permissions.role_id', id)
    .pluck('permissions.name');
  return { ...role, permissions: permissions.sort() };
}

/**
 * All roles with their permission-name arrays and assigned-user counts. Backs
 * the role-editor list.
 */
async function getRolesWithPermissions() {
  const roles = await db('roles')
    .select('id', 'name', 'display_name', 'description', 'is_system', 'priority')
    .orderBy('priority', 'desc');
  const grants = await db('role_permissions')
    .join('permissions', 'permissions.id', 'role_permissions.permission_id')
    .select('role_permissions.role_id as role_id', 'permissions.name as name');
  const userCounts = await db('admin_users')
    .whereNotNull('role_id')
    .select('role_id')
    .count('* as count')
    .groupBy('role_id');

  const permsByRole = new Map();
  for (const g of grants) {
    if (!permsByRole.has(g.role_id)) permsByRole.set(g.role_id, []);
    permsByRole.get(g.role_id).push(g.name);
  }
  const countByRole = new Map(userCounts.map((r) => [r.role_id, Number(r.count)]));

  return roles.map((r) => ({
    ...r,
    permissions: (permsByRole.get(r.id) || []).sort(),
    user_count: countByRole.get(r.id) || 0,
  }));
}

/**
 * The full permission catalog (for the editor's matrix), ordered by category.
 */
async function getPermissionCatalog() {
  return db('permissions')
    .select('id', 'name', 'display_name', 'category', 'description')
    .orderBy(['category', 'name']);
}

/**
 * Create a custom role with an explicit permission set.
 */
async function createRole({ name, displayName, description, priority, permissions }, createdById) {
  const normalized = normalizeRoleName(name);
  if (!/^[a-z][a-z0-9_]{1,48}$/.test(normalized)) {
    throw new ValidationError('Role name must be lowercase letters, numbers and underscores (2–49 chars, starting with a letter).');
  }
  if (RESERVED_ROLE_NAMES.includes(normalized)) {
    throw new ConflictError(`"${normalized}" is a reserved system role name.`);
  }
  const existing = await db('roles').where('name', normalized).first();
  if (existing) throw new ConflictError(`A role named "${normalized}" already exists.`);

  await assertActorMayGrant(createdById, permissions);
  const permIds = await resolvePermissionIds(permissions);
  const rawPriority = Number(priority);
  const safePriority = Number.isFinite(rawPriority) ? Math.max(0, Math.min(99, Math.floor(rawPriority))) : 50;

  let roleId;
  await db.transaction(async (trx) => {
    const ins = await trx('roles').insert({
      name: normalized,
      display_name: displayName || normalized,
      description: description || null,
      is_system: false,
      priority: safePriority,
      created_at: trx.fn.now(),
      updated_at: trx.fn.now(),
    }).returning('id');
    roleId = ins[0]?.id ?? ins[0];
    if (permIds.length > 0) {
      await trx('role_permissions').insert(permIds.map((pid) => ({ role_id: roleId, permission_id: pid })));
    }
  });

  clearPermCache();
  // logActivity AFTER commit — a global-db write inside the trx would deadlock
  // on SQLite. See feedback_sqlite_global_write_in_transaction.
  await logActivity('admin_role_created',
    { roleId, name: normalized, permissionCount: permIds.length },
    null,
    { type: 'admin', id: createdById, name: 'system' });
  logger.info('Role created', { roleId, name: normalized, createdById });
  return getRoleWithPermissionsById(roleId);
}

/**
 * Update a role's display/description/priority and/or replace its permission
 * set. super_admin is fully protected; system roles keep their name + priority.
 */
async function updateRole(id, { displayName, description, priority, permissions }, updatedById) {
  const role = await db('roles').where('id', id).first();
  if (!role) throw new NotFoundError('Role', id);
  if (role.name === 'super_admin') {
    throw new ValidationError('The Super Admin role is protected — it always holds every permission and cannot be edited.');
  }

  // Self-amplification guard: a non-super_admin can't edit their OWN role (which
  // would let a roles.manage holder grant their own role more), and can only
  // grant permissions they already hold. See assertActorMayGrant.
  const actor = await db('admin_users')
    .leftJoin('roles', 'roles.id', 'admin_users.role_id')
    .where('admin_users.id', updatedById)
    .select('admin_users.role_id as role_id', 'roles.name as role_name')
    .first();
  const actorIsSuper = actor && actor.role_name === 'super_admin';
  if (!actorIsSuper && actor && actor.role_id === Number(id)) {
    throw new ForbiddenError('You cannot edit your own role.');
  }
  if (permissions !== undefined) {
    await assertActorMayGrant(updatedById, permissions);
  }

  const patch = { updated_at: db.fn.now() };
  if (displayName !== undefined) patch.display_name = displayName;
  if (description !== undefined) patch.description = description;
  if (priority !== undefined && !role.is_system) {
    const p = Number(priority);
    if (Number.isFinite(p)) patch.priority = Math.max(0, Math.min(99, Math.floor(p)));
  }

  let permIds = null;
  if (permissions !== undefined) {
    permIds = await resolvePermissionIds(permissions);
  }

  await db.transaction(async (trx) => {
    await trx('roles').where('id', id).update(patch);
    if (permIds !== null) {
      await trx('role_permissions').where('role_id', id).del();
      if (permIds.length > 0) {
        await trx('role_permissions').insert(permIds.map((pid) => ({ role_id: id, permission_id: pid })));
      }
    }
  });

  clearPermCache();
  await logActivity('admin_role_updated',
    { roleId: id, name: role.name, permissionsChanged: permIds !== null },
    null,
    { type: 'admin', id: updatedById, name: 'system' });
  logger.info('Role updated', { roleId: id, name: role.name, updatedById });
  return getRoleWithPermissionsById(id);
}

/**
 * Delete a custom role. System roles are protected; a role still assigned to
 * users must be reassigned first (avoids leaving users permission-less).
 */
async function deleteRole(id, deletedById) {
  const role = await db('roles').where('id', id).first();
  if (!role) throw new NotFoundError('Role', id);
  if (role.is_system) throw new ValidationError('System roles cannot be deleted.');

  const assigned = await db('admin_users').where('role_id', id).count('* as count').first();
  if (Number(assigned?.count) > 0) {
    throw new ConflictError('Reassign the users holding this role before deleting it.');
  }

  await db.transaction(async (trx) => {
    await trx('role_permissions').where('role_id', id).del();
    await trx('roles').where('id', id).del();
  });

  clearPermCache();
  await logActivity('admin_role_deleted',
    { roleId: id, name: role.name },
    null,
    { type: 'admin', id: deletedById, name: 'system' });
  logger.info('Role deleted', { roleId: id, name: role.name, deletedById });
}

/**
 * Clone any role (including a preset) into a new custom role with the same
 * permission set — the "start from a preset" flow.
 */
async function cloneRole(sourceId, { name, displayName, description }, createdById) {
  const source = await db('roles').where('id', sourceId).first();
  if (!source) throw new NotFoundError('Role', sourceId);
  const permissions = await db('role_permissions')
    .join('permissions', 'permissions.id', 'role_permissions.permission_id')
    .where('role_permissions.role_id', sourceId)
    .pluck('permissions.name');
  return createRole({
    name,
    displayName: displayName || `${source.display_name} copy`,
    description: description !== undefined ? description : source.description,
    priority: source.is_system ? 50 : source.priority,
    permissions,
  }, createdById);
}

module.exports = {
  createInvitation,
  acceptInvitation,
  getAllAdminUsers,
  getAdminUserById,
  updateAdminUser,
  deactivateAdminUser,
  activateAdminUser,
  deleteAdminUser,
  resetAdminPassword,
  getAllRoles,
  getRolesWithPermissions,
  getPermissionCatalog,
  getRoleWithPermissionsById,
  createRole,
  updateRole,
  deleteRole,
  cloneRole,
  getPendingInvitations,
  cancelInvitation,
  validateInvitationToken,
  assertActorMayGrant
};
