/**
 * Role editor API — create/edit/delete roles and their permission sets, and
 * read the permission catalog for the matrix UI.
 *
 * Mounted at /api/admin/roles. Every mutation is gated by the highly-privileged
 * `roles.manage` permission (held by super_admin + the solo_photographer preset,
 * and grantable to a custom role by the owner). Reads allow `users.view` too so
 * the User Management page can show role details without role-editing rights.
 *
 * System roles (super_admin/admin/editor/viewer/solo_photographer/
 * team_photographer/customer_support) are protected in the service layer: they can't be deleted
 * or renamed, and super_admin's permission set is immutable (the boot self-heal
 * keeps it complete regardless).
 */
const express = require('express');
const { body, param } = require('express-validator');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const userManagementService = require('../services/userManagementService');

const router = express.Router();

const READ_ROLES = ['users.view', 'roles.manage'];

function transformRole(role) {
  return {
    id: role.id,
    name: role.name,
    displayName: role.display_name,
    description: role.description,
    isSystem: role.is_system === true || role.is_system === 1,
    priority: role.priority,
    userCount: role.user_count,
    permissions: role.permissions || [],
  };
}

// GET / — list roles with their permissions + user counts
router.get('/', adminAuth, requirePermission(READ_ROLES), handleAsync(async (req, res) => {
  const roles = await userManagementService.getRolesWithPermissions();
  return successResponse(res, { roles: roles.map(transformRole) });
}));

// GET /permissions — the full permission catalog (for the matrix)
router.get('/permissions', adminAuth, requirePermission(READ_ROLES), handleAsync(async (req, res) => {
  const permissions = await userManagementService.getPermissionCatalog();
  return successResponse(res, { permissions });
}));

// POST / — create a custom role
router.post('/', [
  adminAuth,
  requirePermission('roles.manage'),
  body('name').isString().trim().isLength({ min: 2, max: 49 }),
  body('displayName').optional().isString().trim().isLength({ min: 1, max: 150 }),
  body('description').optional({ nullable: true }).isString().isLength({ max: 500 }),
  body('priority').optional().isInt({ min: 0, max: 99 }),
  body('permissions').optional().isArray(),
  body('permissions.*').optional().isString(),
], handleAsync(async (req, res) => {
  validateRequest(req);
  const role = await userManagementService.createRole({
    name: req.body.name,
    displayName: req.body.displayName,
    description: req.body.description,
    priority: req.body.priority,
    permissions: req.body.permissions || [],
  }, req.admin.id);
  return successResponse(res, { role: transformRole(role) }, 201);
}));

// POST /:id/clone — clone a role (e.g. start from a preset)
router.post('/:id/clone', [
  adminAuth,
  requirePermission('roles.manage'),
  param('id').isInt(),
  body('name').isString().trim().isLength({ min: 2, max: 49 }),
  body('displayName').optional().isString().trim().isLength({ min: 1, max: 150 }),
  body('description').optional({ nullable: true }).isString().isLength({ max: 500 }),
], handleAsync(async (req, res) => {
  validateRequest(req);
  const role = await userManagementService.cloneRole(Number(req.params.id), {
    name: req.body.name,
    displayName: req.body.displayName,
    description: req.body.description,
  }, req.admin.id);
  return successResponse(res, { role: transformRole(role) }, 201);
}));

// PUT /:id — update display/description/priority and/or permission set
router.put('/:id', [
  adminAuth,
  requirePermission('roles.manage'),
  param('id').isInt(),
  body('displayName').optional().isString().trim().isLength({ min: 1, max: 150 }),
  body('description').optional({ nullable: true }).isString().isLength({ max: 500 }),
  body('priority').optional().isInt({ min: 0, max: 99 }),
  body('permissions').optional().isArray(),
  body('permissions.*').optional().isString(),
], handleAsync(async (req, res) => {
  validateRequest(req);
  const role = await userManagementService.updateRole(Number(req.params.id), {
    displayName: req.body.displayName,
    description: req.body.description,
    priority: req.body.priority,
    permissions: req.body.permissions,
  }, req.admin.id);
  return successResponse(res, { role: transformRole(role) });
}));

// DELETE /:id — delete a custom role
router.delete('/:id', [
  adminAuth,
  requirePermission('roles.manage'),
  param('id').isInt(),
], handleAsync(async (req, res) => {
  validateRequest(req);
  await userManagementService.deleteRole(Number(req.params.id), req.admin.id);
  return successResponse(res, { success: true });
}));

module.exports = router;
