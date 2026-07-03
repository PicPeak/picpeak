/**
 * Admin Users Routes
 * Handles user management, roles, and invitations
 */

const express = require('express');
const { body, param } = require('express-validator');
const { adminAuth } = require('../middleware/auth');
const { requirePermission, requireSuperAdmin, getUserPermissions } = require('../middleware/permissions');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const userManagementService = require('../services/userManagementService');
const { IDENTITY_PRESERVING_NORMALIZE_EMAIL } = require('../utils/emailNormalization');
const router = express.Router();

/**
 * Coerce any of the shapes a TIMESTAMP column produces across our
 * supported drivers into a single ISO 8601 string the frontend (and
 * any external API consumer) can safely pass to date-fns / new Date.
 *
 * Postgres → Date object (becomes ISO via JSON.stringify anyway, but
 *   pinning the format defends against driver-side surprises).
 * SQLite → integer milliseconds since epoch (the surface that crashed
 *   the admin Users page in #485 — `parseISO(123456789)` blows up
 *   with "e.split is not a function"). Native installs default to
 *   SQLite, so this path matters every release.
 * Already a string → assume it's a parseable ISO/RFC3339 (Postgres
 *   driver may stringify under JSON serialization mid-pipeline).
 *
 * Returns null/undefined unchanged so an unset last_login surfaces as
 * "Never" in the UI rather than 1970-01-01T00:00:00Z.
 */
function toIso(value) {
  if (value === null || value === undefined || value === '') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  if (typeof value === 'string') {
    // Numeric-as-string ("1778752458666") happens when the SQLite
    // driver stringifies large integers — re-coerce so the frontend
    // doesn't try to parseISO('1778752458666').
    if (/^\d{10,}$/.test(value)) return new Date(Number(value)).toISOString();
    return value;
  }
  return value;
}

/**
 * Transform user object from snake_case (DB) to camelCase (API)
 */
function transformUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    isActive: user.is_active,
    lastLogin: toIso(user.last_login),
    lastLoginIp: user.last_login_ip,
    createdAt: toIso(user.created_at),
    updatedAt: toIso(user.updated_at),
    roleId: user.role_id,
    roleName: user.role_name,
    roleDisplayName: user.role_display_name,
    createdByUsername: user.created_by_username
  };
}

/**
 * Transform role object from snake_case (DB) to camelCase (API)
 */
function transformRole(role) {
  return {
    id: role.id,
    name: role.name,
    displayName: role.display_name,
    description: role.description,
    isSystem: role.is_system,
    priority: role.priority
  };
}

/**
 * Transform invitation object from snake_case (DB) to camelCase (API)
 */
function transformInvitation(invitation) {
  return {
    id: invitation.id,
    email: invitation.email,
    expiresAt: toIso(invitation.expires_at),
    createdAt: toIso(invitation.created_at),
    roleName: invitation.role_name,
    invitedBy: invitation.invited_by
  };
}

/**
 * GET /me/permissions
 * Get current user's permissions
 */
router.get('/me/permissions', adminAuth, handleAsync(async (req, res) => {
  const permissions = await getUserPermissions(req.admin.id);
  res.json(permissions);
}));

/**
 * GET /
 * List all admin users
 * Requires: users.view permission
 */
router.get('/', adminAuth, requirePermission('users.view'), handleAsync(async (req, res) => {
  const users = await userManagementService.getAllAdminUsers();
  res.json({ users: users.map(transformUser) });
}));

/**
 * GET /roles
 * List all roles
 * Requires: users.view permission
 */
router.get('/roles', adminAuth, requirePermission('users.view'), handleAsync(async (req, res) => {
  const roles = await userManagementService.getAllRoles();
  res.json({ roles: roles.map(transformRole) });
}));

/**
 * GET /invitations
 * List pending invitations
 * Requires: users.view permission
 */
router.get('/invitations', adminAuth, requirePermission('users.view'), handleAsync(async (req, res) => {
  const invitations = await userManagementService.getPendingInvitations();
  res.json({ invitations: invitations.map(transformInvitation) });
}));

/**
 * POST /invite
 * Create invitation
 * Requires: users.create permission
 */
router.post('/invite', [
  adminAuth,
  requirePermission('users.create'),
  body('email').isEmail().normalizeEmail(IDENTITY_PRESERVING_NORMALIZE_EMAIL).withMessage('Valid email is required'),
  body('role_id').isInt({ min: 1 }).withMessage('Role ID is required')
], handleAsync(async (req, res) => {
  validateRequest(req);

  const invitation = await userManagementService.createInvitation({
    email: req.body.email,
    roleId: req.body.role_id,
    invitedById: req.admin.id,
    inviterRoleName: req.admin.roleName
  });

  successResponse(res, { invitation }, 201);
}));

/**
 * DELETE /invitations/:id
 * Cancel invitation
 * Requires: users.create permission
 */
router.delete('/invitations/:id', [
  adminAuth,
  requirePermission('users.create'),
  param('id').isInt({ min: 1 }).withMessage('Valid invitation ID is required')
], handleAsync(async (req, res) => {
  validateRequest(req);
  await userManagementService.cancelInvitation(parseInt(req.params.id), req.admin.id);
  successResponse(res, { message: 'Invitation cancelled' });
}));

/**
 * GET /:id
 * Get single user
 * Requires: users.view permission
 */
router.get('/:id', [
  adminAuth,
  requirePermission('users.view'),
  param('id').isInt({ min: 1 }).withMessage('Valid user ID is required')
], handleAsync(async (req, res) => {
  validateRequest(req);
  const targetId = parseInt(req.params.id);
  // Non-super_admin users can only view their own profile
  if (req.admin.roleName !== 'super_admin' && targetId !== req.admin.id) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const user = await userManagementService.getAdminUserById(targetId);
  res.json({ user: transformUser(user) });
}));

/**
 * PUT /:id
 * Update user
 * Requires: users.edit permission
 */
router.put('/:id', [
  adminAuth,
  requirePermission('users.edit'),
  param('id').isInt({ min: 1 }).withMessage('Valid user ID is required'),
  body('username').optional().trim().isLength({ min: 3, max: 50 }).withMessage('Username must be 3-50 characters'),
  body('email').optional().isEmail().normalizeEmail(IDENTITY_PRESERVING_NORMALIZE_EMAIL).withMessage('Valid email is required'),
  body('role_id').optional().isInt({ min: 1 }).withMessage('Valid role ID is required'),
  body('is_active').optional().isBoolean().withMessage('is_active must be boolean')
], handleAsync(async (req, res) => {
  validateRequest(req);

  const user = await userManagementService.updateAdminUser(
    parseInt(req.params.id),
    req.body,
    req.admin.id,
    { roleName: req.admin.roleName }
  );

  successResponse(res, { user: transformUser(user), message: 'User updated successfully' });
}));

/**
 * POST /:id/deactivate
 * Deactivate user
 * Requires: users.delete permission
 */
router.post('/:id/deactivate', [
  adminAuth,
  requirePermission('users.delete'),
  param('id').isInt({ min: 1 }).withMessage('Valid user ID is required')
], handleAsync(async (req, res) => {
  validateRequest(req);
  await userManagementService.deactivateAdminUser(parseInt(req.params.id), req.admin.id);
  successResponse(res, { message: 'User deactivated successfully' });
}));

/**
 * POST /:id/activate
 * Re-activate a previously deactivated user — symmetric counterpart
 * to /deactivate. Same permission tier; reverting a deactivation is
 * the same scope of action as performing one.
 *
 * #574 follow-up: before this endpoint existed, deactivation was a
 * one-way door from the UI.
 */
router.post('/:id/activate', [
  adminAuth,
  requirePermission('users.delete'),
  param('id').isInt({ min: 1 }).withMessage('Valid user ID is required')
], handleAsync(async (req, res) => {
  validateRequest(req);
  await userManagementService.activateAdminUser(parseInt(req.params.id), req.admin.id);
  successResponse(res, { message: 'User activated successfully' });
}));

/**
 * DELETE /:id
 * Hard-delete an admin user. Caller should typically deactivate
 * first; the UI nudges this order. FK rules in core migrations
 * cascade-delete the user's pending invitations + api_tokens and
 * SET NULL on created_by_admin_id columns elsewhere.
 *
 * Requires: users.delete permission. Self-delete + last-super-admin
 * are blocked in the service.
 */
router.delete('/:id', [
  adminAuth,
  requirePermission('users.delete'),
  param('id').isInt({ min: 1 }).withMessage('Valid user ID is required')
], handleAsync(async (req, res) => {
  validateRequest(req);
  await userManagementService.deleteAdminUser(parseInt(req.params.id), req.admin.id);
  successResponse(res, { message: 'User deleted successfully' });
}));

/**
 * POST /:id/reset-password
 * Reset user password
 * Requires: super_admin role
 */
router.post('/:id/reset-password', [
  adminAuth,
  requireSuperAdmin(),
  param('id').isInt({ min: 1 }).withMessage('Valid user ID is required')
], handleAsync(async (req, res) => {
  validateRequest(req);
  const result = await userManagementService.resetAdminPassword(parseInt(req.params.id), req.admin.id);
  successResponse(res, { message: 'Password reset email sent', ...result });
}));

// Test surface: expose the date normaliser so the unit test can pin
// the contract without spinning up the full router.
module.exports = router;
module.exports.__test = { toIso, transformUser, transformInvitation };
