/**
 * Permission Checking Middleware for RBAC
 * Provides role-based access control with caching for performance
 */

const { db } = require('../database/db');
const { ForbiddenError } = require('../utils/errors');
const logger = require('../utils/logger');

// Cache for role permissions (refreshed periodically)
let permissionCache = new Map();
let cacheLastUpdated = 0;
const CACHE_TTL = 60000; // 1 minute

/**
 * Refresh permission cache from database
 * Handles upgrade scenario where RBAC tables may not exist yet
 */
async function refreshPermissionCache() {
  const now = Date.now();
  if (now - cacheLastUpdated < CACHE_TTL && permissionCache.size > 0) {
    return;
  }

  try {
    const rolePermissions = await db('role_permissions')
      .join('roles', 'roles.id', 'role_permissions.role_id')
      .join('permissions', 'permissions.id', 'role_permissions.permission_id')
      .select('roles.name as role_name', 'permissions.name as permission_name');

    const newCache = new Map();
    for (const rp of rolePermissions) {
      if (!newCache.has(rp.role_name)) {
        newCache.set(rp.role_name, new Set());
      }
      newCache.get(rp.role_name).add(rp.permission_name);
    }

    permissionCache = newCache;
    cacheLastUpdated = now;
  } catch (error) {
    // Handle case where RBAC tables don't exist yet (upgrade scenario)
    // Grant super_admin all permissions by default during upgrade window
    if (error.message.includes('no such table') || error.message.includes('does not exist') || error.message.includes('relation')) {
      logger.warn('RBAC tables not available yet - granting full access to authenticated users during upgrade');
      const allPermissions = new Set([
        'events.view', 'events.create', 'events.edit', 'events.delete', 'events.archive',
        'photos.view', 'photos.upload', 'photos.edit', 'photos.delete', 'photos.download',
        'archives.view', 'archives.restore', 'archives.download', 'archives.delete',
        'analytics.view', 'email.view', 'email.edit', 'email.send',
        'branding.view', 'branding.edit', 'cms.view', 'cms.edit',
        'settings.view', 'settings.edit', 'backup.view', 'backup.create', 'backup.restore', 'backup.delete',
        'users.view', 'users.create', 'users.edit', 'users.delete',
        'activity.view', 'activity.export'
      ]);
      permissionCache.set('super_admin', allPermissions);
      cacheLastUpdated = now;
    } else {
      logger.error('Failed to refresh permission cache', { error: error.message });
    }
  }
}

/**
 * Check if a role has a specific permission
 * @param {string} roleName - Role name to check
 * @param {string} permissionName - Permission name to check
 * @returns {Promise<boolean>}
 */
async function roleHasPermission(roleName, permissionName) {
  await refreshPermissionCache();
  const rolePerms = permissionCache.get(roleName);
  return rolePerms ? rolePerms.has(permissionName) : false;
}

/**
 * Check if user has any of the specified permissions
 * @param {number} userId - User ID to check
 * @param {string[]} permissions - Array of permission names
 * @returns {Promise<boolean>}
 */
async function userHasAnyPermission(userId, permissions) {
  const user = await db('admin_users')
    .join('roles', 'roles.id', 'admin_users.role_id')
    .where('admin_users.id', userId)
    .select('roles.name as role_name')
    .first();

  if (!user) return false;

  for (const perm of permissions) {
    if (await roleHasPermission(user.role_name, perm)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if user has all specified permissions
 * @param {number} userId - User ID to check
 * @param {string[]} permissions - Array of permission names
 * @returns {Promise<boolean>}
 */
async function userHasAllPermissions(userId, permissions) {
  const user = await db('admin_users')
    .join('roles', 'roles.id', 'admin_users.role_id')
    .where('admin_users.id', userId)
    .select('roles.name as role_name')
    .first();

  if (!user) return false;

  for (const perm of permissions) {
    if (!(await roleHasPermission(user.role_name, perm))) {
      return false;
    }
  }
  return true;
}

/**
 * Middleware factory: require specific permission(s)
 * @param {string|string[]} permissions - Permission name(s) required
 * @param {object} options - { requireAll: boolean }
 * @returns {Function} Express middleware
 */
function requirePermission(permissions, options = { requireAll: false }) {
  const permArray = Array.isArray(permissions) ? permissions : [permissions];

  return async (req, res, next) => {
    try {
      if (!req.admin || !req.admin.id) {
        throw new ForbiddenError('Authentication required');
      }

      const hasPermission = options.requireAll
        ? await userHasAllPermissions(req.admin.id, permArray)
        : await userHasAnyPermission(req.admin.id, permArray);

      if (!hasPermission) {
        logger.warn('Permission denied', {
          userId: req.admin.id,
          username: req.admin.username,
          requiredPermissions: permArray,
          path: req.path,
          method: req.method
        });
        throw new ForbiddenError('Insufficient permissions');
      }

      next();
    } catch (error) {
      if (error instanceof ForbiddenError) {
        return res.status(403).json({ error: error.message, code: 'FORBIDDEN' });
      }
      next(error);
    }
  };
}

/**
 * Middleware: require super_admin role
 * @returns {Function} Express middleware
 */
function requireSuperAdmin() {
  return async (req, res, next) => {
    try {
      if (!req.admin || !req.admin.id) {
        throw new ForbiddenError('Authentication required');
      }

      const user = await db('admin_users')
        .join('roles', 'roles.id', 'admin_users.role_id')
        .where('admin_users.id', req.admin.id)
        .select('roles.name as role_name')
        .first();

      if (!user || user.role_name !== 'super_admin') {
        logger.warn('Super admin access denied', {
          userId: req.admin.id,
          username: req.admin.username,
          path: req.path,
          method: req.method
        });
        throw new ForbiddenError('Super Admin access required');
      }

      next();
    } catch (error) {
      if (error instanceof ForbiddenError) {
        return res.status(403).json({ error: error.message, code: 'FORBIDDEN' });
      }
      next(error);
    }
  };
}

/**
 * Get user's permissions for client
 * @param {number} userId - User ID
 * @returns {Promise<{role: object|null, permissions: string[]}>}
 */
async function getUserPermissions(userId) {
  const user = await db('admin_users')
    .join('roles', 'roles.id', 'admin_users.role_id')
    .where('admin_users.id', userId)
    .select('roles.name as role_name', 'roles.display_name as role_display_name')
    .first();

  if (!user) return { role: null, permissions: [] };

  await refreshPermissionCache();
  const permissions = permissionCache.get(user.role_name) || new Set();

  return {
    role: {
      name: user.role_name,
      displayName: user.role_display_name
    },
    permissions: Array.from(permissions)
  };
}

/**
 * Clear permission cache (useful for testing or when permissions change)
 */
function clearPermissionCache() {
  permissionCache.clear();
  cacheLastUpdated = 0;
}

module.exports = {
  requirePermission,
  requireSuperAdmin,
  getUserPermissions,
  userHasAnyPermission,
  userHasAllPermissions,
  roleHasPermission,
  refreshPermissionCache,
  clearPermissionCache
};
