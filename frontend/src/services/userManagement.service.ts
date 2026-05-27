import { api } from '../config/api';
import type { AdminUser, AdminRole, AdminInvitation } from '../types';

/**
 * Defence-in-depth normalisation for date fields (#485). The backend
 * now always returns these as ISO strings via toIso() in adminUsers.js,
 * but this wrapper:
 *
 *   - Lets the page survive a stale backend during a mid-deploy window
 *     (older backend still returns SQLite epoch-ms numbers).
 *   - Lets the page survive an external API consumer's response cache
 *     that captured the pre-fix shape.
 *
 * The original crash was `parseISO(123456789)` in
 * AdminUsersPage → `e.split is not a function`. Coercing here means
 * the next consumer of the AdminUser type can rely on the field
 * being a string regardless of how it landed.
 */
function normalizeDateValue(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === '') return value as null | undefined;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  if (typeof value === 'string') {
    // SQLite via some drivers stringifies large integers — coerce back.
    if (/^\d{10,}$/.test(value)) return new Date(Number(value)).toISOString();
    return value;
  }
  return undefined;
}

// Transform snake_case API response to camelCase for frontend
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function transformUser(user: any): AdminUser {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    isActive: user.isActive ?? user.is_active,
    lastLogin: normalizeDateValue(user.lastLogin ?? user.last_login),
    lastLoginIp: user.lastLoginIp ?? user.last_login_ip,
    createdAt: normalizeDateValue(user.createdAt ?? user.created_at),
    updatedAt: normalizeDateValue(user.updatedAt ?? user.updated_at),
    roleId: user.roleId ?? user.role_id,
    roleName: user.roleName ?? user.role_name,
    roleDisplayName: user.roleDisplayName ?? user.role_display_name,
    createdByUsername: user.createdByUsername ?? user.created_by_username,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function transformInvitation(invitation: any): AdminInvitation {
  return {
    id: invitation.id,
    email: invitation.email,
    roleName: invitation.roleName ?? invitation.role_name,
    invitedBy: invitation.invitedBy ?? invitation.invited_by,
    expiresAt: normalizeDateValue(invitation.expiresAt ?? invitation.expires_at) as string,
    createdAt: normalizeDateValue(invitation.createdAt ?? invitation.created_at) as string,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function transformRole(role: any): AdminRole {
  return {
    id: role.id,
    name: role.name,
    displayName: role.displayName ?? role.display_name,
    description: role.description,
    isSystem: role.isSystem ?? role.is_system,
    priority: role.priority,
  };
}

interface GetUsersResponse {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  users: any[];
}

interface GetUserResponse {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  user: any;
}

interface GetRolesResponse {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  roles: any[];
}

interface GetInvitationsResponse {
  invitations: AdminInvitation[];
}

interface CreateInvitationData {
  email: string;
  role_id: number;
}

interface CreateInvitationResponse {
  invitation: AdminInvitation;
  message: string;
}

interface UpdateUserData {
  roleId?: number;
  isActive?: boolean;
}

interface UpdateUserResponse {
  user: AdminUser;
}

interface DeactivateUserResponse {
  message: string;
}

interface ResetPasswordResponse {
  temporaryPassword: string;
  message: string;
}

interface ValidateInvitationResponse {
  valid: boolean;
  email: string;
  roleName: string;
  invitedBy: string;
  expiresAt: string;
}

interface AcceptInvitationData {
  username: string;
  password: string;
}

interface AcceptInvitationResponse {
  message: string;
  user: AdminUser;
}

export const userManagementService = {
  /**
   * Get all admin users
   */
  async getUsers(): Promise<AdminUser[]> {
    const response = await api.get<GetUsersResponse>('/admin/users');
    return response.data.users.map(transformUser);
  },

  /**
   * Get a single admin user by ID
   */
  async getUser(id: number): Promise<AdminUser> {
    const response = await api.get<GetUserResponse>(`/admin/users/${id}`);
    return transformUser(response.data.user);
  },

  /**
   * Get all available roles
   */
  async getRoles(): Promise<AdminRole[]> {
    const response = await api.get<GetRolesResponse>('/admin/users/roles');
    return response.data.roles.map(transformRole);
  },

  /**
   * Get all pending invitations
   */
  async getInvitations(): Promise<AdminInvitation[]> {
    const response = await api.get<GetInvitationsResponse>('/admin/users/invitations');
    return response.data.invitations.map(transformInvitation);
  },

  /**
   * Create a new invitation
   */
  async createInvitation(data: CreateInvitationData): Promise<AdminInvitation> {
    const response = await api.post<CreateInvitationResponse>('/admin/users/invite', data);
    return transformInvitation(response.data.invitation);
  },

  /**
   * Cancel a pending invitation
   */
  async cancelInvitation(id: number): Promise<void> {
    await api.delete(`/admin/users/invitations/${id}`);
  },

  /**
   * Update an admin user
   */
  async updateUser(id: number, data: UpdateUserData): Promise<AdminUser> {
    // Convert camelCase to snake_case for backend API
    const payload: Record<string, unknown> = {};
    if (data.roleId !== undefined) payload.role_id = data.roleId;
    if (data.isActive !== undefined) payload.is_active = data.isActive;
    const response = await api.put<UpdateUserResponse>(`/admin/users/${id}`, payload);
    return transformUser(response.data.user);
  },

  /**
   * Deactivate an admin user
   */
  async deactivateUser(id: number): Promise<string> {
    const response = await api.post<DeactivateUserResponse>(`/admin/users/${id}/deactivate`);
    return response.data.message;
  },

  /**
   * Reset an admin user's password
   */
  async resetPassword(id: number): Promise<ResetPasswordResponse> {
    const response = await api.post<ResetPasswordResponse>(`/admin/users/${id}/reset-password`);
    return response.data;
  },

  /**
   * Validate an invitation token (public endpoint)
   */
  async validateInvitation(token: string): Promise<ValidateInvitationResponse> {
    const response = await api.get<ValidateInvitationResponse>(`/invite/${token}`);
    return response.data;
  },

  /**
   * Accept an invitation and create account (public endpoint)
   */
  async acceptInvitation(token: string, data: AcceptInvitationData): Promise<AcceptInvitationResponse> {
    const response = await api.post<AcceptInvitationResponse>(`/invite/${token}`, data);
    return response.data;
  },
};
