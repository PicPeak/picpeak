import { api } from '../config/api';

/**
 * Role-editor API client (backend: adminRoles.js). Lets an owner create custom
 * roles, edit any role's permission set, clone a preset, and delete custom
 * roles. Every mutation is gated by `roles.manage` on the backend.
 */

export interface PermissionDef {
  id: number;
  name: string;
  display_name: string;
  category: string;
  description?: string | null;
}

export interface RoleWithPermissions {
  id: number;
  name: string;
  displayName: string;
  description?: string | null;
  isSystem: boolean;
  priority?: number;
  userCount: number;
  permissions: string[];
}

interface RolesResponse { roles: RoleWithPermissions[] }
interface RoleResponse { role: RoleWithPermissions }
interface PermissionsResponse { permissions: PermissionDef[] }

export interface CreateRolePayload {
  name: string;
  displayName?: string;
  description?: string | null;
  priority?: number;
  permissions?: string[];
}

export interface UpdateRolePayload {
  displayName?: string;
  description?: string | null;
  priority?: number;
  permissions?: string[];
}

export const rolesService = {
  async getRoles(): Promise<RoleWithPermissions[]> {
    const res = await api.get<RolesResponse>('/admin/roles');
    return res.data.roles;
  },

  async getPermissionCatalog(): Promise<PermissionDef[]> {
    const res = await api.get<PermissionsResponse>('/admin/roles/permissions');
    return res.data.permissions;
  },

  async createRole(payload: CreateRolePayload): Promise<RoleWithPermissions> {
    const res = await api.post<RoleResponse>('/admin/roles', payload);
    return res.data.role;
  },

  async updateRole(id: number, payload: UpdateRolePayload): Promise<RoleWithPermissions> {
    const res = await api.put<RoleResponse>(`/admin/roles/${id}`, payload);
    return res.data.role;
  },

  async deleteRole(id: number): Promise<void> {
    await api.delete(`/admin/roles/${id}`);
  },
};
