import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import {
  Users,
  Mail,
  Plus,
  Search,
  Edit,
  UserX,
  UserCheck,
  AlertTriangle,
  Clock,
  Shield,
  Trash2,
  CheckCircle,
  XCircle,
  MailCheck,
} from 'lucide-react';
import { parseISO, isPast } from 'date-fns';

import { Badge, Button, Input, Card, Loading, Modal, Tabs, ErrorState, EmptyState, Table, TableHead, TableBody, TableRow, TableHeaderCell, TableCell } from '../../components/common';
import type { BadgeTone } from '../../components/common';
import { SectionPageHeader } from '../../components/admin/SectionPageHeader';
import { userManagementService } from '../../services/userManagement.service';
import type { AdminUser, AdminRole, AdminInvitation } from '../../types';
import { useLocalizedDate, useModal, useMutationWithToast } from "../../hooks";
import { usePermissions } from '../../contexts/PermissionsContext';
import { RoleManagementTab } from '../../components/admin/RoleManagementTab';

type TabType = 'users' | 'invitations' | 'roles';

// Role badge tones
const getRoleBadgeTone = (roleName: string): BadgeTone => {
  switch (roleName?.toLowerCase()) {
    case 'super_admin':
      return 'danger';
    case 'admin':
      return 'info';
    case 'editor':
      return 'success';
    case 'viewer':
    default:
      return 'neutral';
  }
};

// Modal component for creating invitations
interface CreateInvitationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (email: string, roleId: number) => void;
  roles: AdminRole[];
  isLoading: boolean;
}

const CreateInvitationModal: React.FC<CreateInvitationModalProps> = ({
  isOpen,
  onClose,
  onSubmit,
  roles,
  isLoading,
}) => {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState<number | ''>('');
  const [errors, setErrors] = useState<{ email?: string; role?: string }>({});

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const newErrors: { email?: string; role?: string } = {};

    if (!email) {
      newErrors.email = t('userManagement.validation.emailRequired');
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      newErrors.email = t('userManagement.validation.emailInvalid');
    }

    if (!roleId) {
      newErrors.role = t('userManagement.validation.roleRequired');
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    onSubmit(email, roleId as number);
  };

  const handleClose = () => {
    setEmail('');
    setRoleId('');
    setErrors({});
    onClose();
  };

  return (
    <Modal
      open={isOpen}
      onClose={() => { if (!isLoading) handleClose(); }}
      title={t('userManagement.createInvitation')}
      size="sm"
      footer={(
        <>
          <Button
            type="button"
            variant="outline"
            onClick={handleClose}
            disabled={isLoading}
          >
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            form="create-invitation-form"
            variant="primary"
            isLoading={isLoading}
            leftIcon={<Mail className="w-4 h-4" />}
          >
            {t('userManagement.sendInvitation')}
          </Button>
        </>
      )}
    >
          <form id="create-invitation-form" onSubmit={handleSubmit}>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-body mb-1">
                  {t('userManagement.email')}
                </label>
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setErrors((prev) => ({ ...prev, email: undefined }));
                  }}
                  placeholder={t('userManagement.emailPlaceholder')}
                  disabled={isLoading}
                />
                {errors.email && (
                  <p className="mt-1 text-sm text-danger-text">{errors.email}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-body mb-1">
                  {t('userManagement.role')}
                </label>
                <select
                  value={roleId}
                  onChange={(e) => {
                    setRoleId(e.target.value ? Number(e.target.value) : '');
                    setErrors((prev) => ({ ...prev, role: undefined }));
                  }}
                  className="w-full px-3 py-2 border border-line-strong bg-panel text-heading rounded-lg focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent-dark"
                  disabled={isLoading}
                >
                  <option value="">{t('userManagement.selectRole')}</option>
                  {roles.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.displayName}
                    </option>
                  ))}
                </select>
                {errors.role && (
                  <p className="mt-1 text-sm text-danger-text">{errors.role}</p>
                )}
              </div>
            </div>
          </form>
    </Modal>
  );
};

// Modal component for editing users
interface EditUserModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (userId: number, roleId: number, creditName: string | null) => void;
  user: AdminUser | null;
  roles: AdminRole[];
  isLoading: boolean;
}

const EditUserModal: React.FC<EditUserModalProps> = ({
  isOpen,
  onClose,
  onSubmit,
  user,
  roles,
  isLoading,
}) => {
  const { t } = useTranslation();
  const [roleId, setRoleId] = useState<number | ''>('');
  const [creditName, setCreditName] = useState('');

  React.useEffect(() => {
    if (user?.roleId) {
      setRoleId(user.roleId);
    }
    setCreditName(user?.creditName || '');
  }, [user]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !roleId) return;
    onSubmit(user.id, roleId as number, creditName.trim() || null);
  };

  const handleClose = () => {
    setRoleId('');
    setCreditName('');
    onClose();
  };

  if (!user) return null;

  return (
    <Modal
      open={isOpen}
      onClose={() => { if (!isLoading) handleClose(); }}
      title={t('userManagement.editUser')}
      size="sm"
      footer={(
        <>
          <Button
            type="button"
            variant="outline"
            onClick={handleClose}
            disabled={isLoading}
          >
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            form="edit-user-form"
            variant="primary"
            isLoading={isLoading}
            leftIcon={<Edit className="w-4 h-4" />}
          >
            {t('userManagement.saveChanges')}
          </Button>
        </>
      )}
    >

          <div className="mb-4 p-3 bg-inset rounded-lg">
            <p className="text-sm text-body">
              {t('userManagement.editingUser')}: <strong>{user.username}</strong>
            </p>
            <p className="text-sm text-muted">{user.email}</p>
          </div>

          <form id="edit-user-form" onSubmit={handleSubmit}>
            <div>
              <label className="block text-sm font-medium text-body mb-1">
                {t('userManagement.role')}
              </label>
              <select
                value={roleId}
                onChange={(e) => setRoleId(e.target.value ? Number(e.target.value) : '')}
                className="w-full px-3 py-2 border border-line-strong bg-panel text-heading rounded-lg focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent-dark"
                disabled={isLoading}
              >
                <option value="">{t('userManagement.selectRole')}</option>
                {roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.displayName}
                  </option>
                ))}
              </select>
            </div>

            <div className="mt-4">
              <label htmlFor="edit-user-credit-name" className="block text-sm font-medium text-body mb-1">
                {t('settings.general.accountCreditName', 'Photo credit')}
              </label>
              <Input
                id="edit-user-credit-name"
                type="text"
                value={creditName}
                onChange={(e) => setCreditName(e.target.value)}
                maxLength={100}
                disabled={isLoading}
              />
              <p className="text-xs text-muted mt-1">
                {t('userManagement.creditNameHelp', 'Credited on photos this account uploads when the file has no photographer name in its metadata.')}
              </p>
            </div>
          </form>
    </Modal>
  );
};

// Confirmation dialog component
interface ConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmText: string;
  isLoading: boolean;
  variant?: 'danger' | 'warning';
}

const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText,
  isLoading,
  variant = 'danger',
}) => {
  const { t } = useTranslation();

  // Stays open while the action runs and on a failure, so the admin sees
  // the outcome; the caller closes it on success.
  return (
    <Modal
      open={isOpen}
      onClose={() => { if (!isLoading) onClose(); }}
      title={title}
      size="sm"
      footer={(
        <>
          <Button
            variant="outline"
            onClick={onClose}
            disabled={isLoading}
          >
            {t('common.cancel')}
          </Button>
          <Button
            variant={variant === 'danger' ? 'danger' : 'primary'}
            onClick={onConfirm}
            isLoading={isLoading}
          >
            {confirmText}
          </Button>
        </>
      )}
    >
      <div className="flex items-start gap-3">
        <AlertTriangle
          className={`w-5 h-5 flex-shrink-0 ${
            variant === 'danger' ? 'text-danger-text' : 'text-warning-text'
          }`}
          aria-hidden="true"
        />
        <p className="text-sm text-soft">{message}</p>
      </div>
    </Modal>
  );
};

export const UserManagementPage: React.FC = () => {
  const { t } = useTranslation();
  const { formatDistanceToNow } = useLocalizedDate()
  const { hasAnyPermission, isSuperAdmin } = usePermissions();
  const canManageRoles = hasAnyPermission(['roles.manage', 'users.view']);

  // State
  const [activeTab, setActiveTab] = useState<TabType>('users');
  const [searchTerm, setSearchTerm] = useState('');
  const createInvitationModal = useModal();
  const editUserModal = useModal();
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    type: 'deactivate' | 'activate' | 'delete' | 'cancelInvitation' | 'confirmEmail';
    id: number;
    name: string;
    email?: string;
  } | null>(null);

  // Queries
  const {
    data: users,
    isLoading: usersLoading,
    error: usersError,
    refetch: refetchUsers,
  } = useQuery({
    queryKey: ['admin-users'],
    queryFn: userManagementService.getUsers,
  });

  const {
    data: roles,
    isLoading: rolesLoading,
  } = useQuery({
    queryKey: ['admin-roles'],
    queryFn: userManagementService.getRoles,
  });

  const {
    data: invitations,
    isLoading: invitationsLoading,
    error: invitationsError,
    refetch: refetchInvitations,
  } = useQuery({
    queryKey: ['admin-invitations'],
    queryFn: userManagementService.getInvitations,
  });

  // Mutations
  const createInvitationMutation = useMutationWithToast({
    mutationFn: ({ email, roleId }: { email: string; roleId: number }) =>
      userManagementService.createInvitation({ email, role_id: roleId }),
    invalidateKeys: [['admin-invitations']],
    successMessage: t('userManagement.invitationSent'),
    // Same here: the function form would show axios's own "Request failed with
    // status code 409" instead of the server's reason for refusing the invite.
    errorMessage: t('userManagement.invitationError'),
    onSuccess: () => {
      createInvitationModal.close();
    },
  });

  const cancelInvitationMutation = useMutationWithToast({
    mutationFn: userManagementService.cancelInvitation,
    invalidateKeys: [['admin-invitations']],
    successMessage: t('userManagement.invitationCancelled'),
    errorMessage: () => t('userManagement.cancelInvitationError'),
    onSuccess: () => {
      setConfirmDialog(null);
    },
  });

  const updateUserMutation = useMutationWithToast({
    mutationFn: ({ id, roleId, creditName }: { id: number; roleId: number; creditName: string | null }) =>
      userManagementService.updateUser(id, { roleId, creditName }),
    invalidateKeys: [['admin-users']],
    successMessage: t('userManagement.userUpdated'),
    errorMessage: () => t('userManagement.updateUserError'),
    onSuccess: () => {
      editUserModal.close();
      setSelectedUser(null);
    },
  });

  const deactivateUserMutation = useMutationWithToast({
    mutationFn: userManagementService.deactivateUser,
    invalidateKeys: [['admin-users']],
    successMessage: t('userManagement.userDeactivated'),
    errorMessage: () => t('userManagement.deactivateUserError'),
    onSuccess: () => {
      setConfirmDialog(null);
    },
  });

  // #574 follow-up: reactivate + delete actions for the rows the
  // deactivate button used to leave unmanageable.
  const activateUserMutation = useMutationWithToast({
    mutationFn: userManagementService.activateUser,
    invalidateKeys: [['admin-users']],
    successMessage: t('userManagement.userActivated', 'User reactivated successfully'),
    errorMessage: () => t('userManagement.activateUserError', 'Failed to reactivate user'),
    onSuccess: () => {
      setConfirmDialog(null);
    },
  });

  // SSO email linking (migration 227): a Super Admin re-saving an admin's own
  // address is what marks it as set by a trusted flow. The address itself does
  // not change — this only confirms it — so the page sends it back unaltered.
  const confirmEmailMutation = useMutationWithToast({
    mutationFn: ({ id, email }: { id: number; email: string }) =>
      userManagementService.updateUser(id, { email }),
    invalidateKeys: [['admin-users']],
    successMessage: t('userManagement.emailConfirmed', 'Email confirmed for single sign-on'),
    // The string form, not a function: useMutationWithToast reads the server's
    // own message first for that one and falls back to this. A 409 here means
    // the address changed under the dialog, and saying so is the whole point.
    errorMessage: t('userManagement.confirmEmailError', 'Failed to confirm the email'),
    onSuccess: () => {
      setConfirmDialog(null);
    },
  });

  const deleteUserMutation = useMutationWithToast({
    mutationFn: userManagementService.deleteUser,
    invalidateKeys: [['admin-users']],
    successMessage: t('userManagement.userDeleted', 'User deleted successfully'),
    errorMessage: () => t('userManagement.deleteUserError', 'Failed to delete user'),
    onSuccess: () => {
      setConfirmDialog(null);
    },
  });

  // Filtered data
  const filteredUsers = useMemo(() => {
    if (!users) return [];
    if (!searchTerm) return users;

    const term = searchTerm.toLowerCase();
    return users.filter(
      (user) =>
        user.username.toLowerCase().includes(term) ||
        user.email.toLowerCase().includes(term) ||
        user.roleName?.toLowerCase().includes(term)
    );
  }, [users, searchTerm]);

  const filteredInvitations = useMemo(() => {
    if (!invitations) return [];
    if (!searchTerm) return invitations;

    const term = searchTerm.toLowerCase();
    return invitations.filter(
      (invitation) =>
        invitation.email.toLowerCase().includes(term) ||
        invitation.roleName?.toLowerCase().includes(term)
    );
  }, [invitations, searchTerm]);

  // Handlers
  const handleCreateInvitation = (email: string, roleId: number) => {
    createInvitationMutation.mutate({ email, roleId });
  };

  const handleEditUser = (user: AdminUser) => {
    setSelectedUser(user);
    editUserModal.open();
  };

  const handleUpdateUser = (userId: number, roleId: number, creditName: string | null) => {
    updateUserMutation.mutate({ id: userId, roleId, creditName });
  };

  const handleDeactivateUser = (user: AdminUser) => {
    setConfirmDialog({
      isOpen: true,
      type: 'deactivate',
      id: user.id,
      name: user.username,
    });
  };

  const handleActivateUser = (user: AdminUser) => {
    setConfirmDialog({
      isOpen: true,
      type: 'activate',
      id: user.id,
      name: user.username,
    });
  };

  const handleDeleteUser = (user: AdminUser) => {
    setConfirmDialog({
      isOpen: true,
      type: 'delete',
      id: user.id,
      name: user.username,
    });
  };

  const handleConfirmEmail = (user: AdminUser) => {
    setConfirmDialog({
      isOpen: true,
      type: 'confirmEmail',
      id: user.id,
      name: user.username,
      email: user.email,
    });
  };

  const handleCancelInvitation = (invitation: AdminInvitation) => {
    setConfirmDialog({
      isOpen: true,
      type: 'cancelInvitation',
      id: invitation.id,
      name: invitation.email,
    });
  };

  const handleConfirmAction = () => {
    if (!confirmDialog) return;

    if (confirmDialog.type === 'deactivate') {
      deactivateUserMutation.mutate(confirmDialog.id);
    } else if (confirmDialog.type === 'activate') {
      activateUserMutation.mutate(confirmDialog.id);
    } else if (confirmDialog.type === 'delete') {
      deleteUserMutation.mutate(confirmDialog.id);
    } else if (confirmDialog.type === 'confirmEmail') {
      // The dialog is only ever opened from a row, which always has an
      // address; an empty one would be a 400 with no useful message.
      if (confirmDialog.email) {
        confirmEmailMutation.mutate({ id: confirmDialog.id, email: confirmDialog.email });
      }
    } else if (confirmDialog.type === 'cancelInvitation') {
      cancelInvitationMutation.mutate(confirmDialog.id);
    }
  };

  // Loading state
  const isLoading = usersLoading || rolesLoading || invitationsLoading;

  const pageHeader = (
    <SectionPageHeader
      icon={Users}
      title={t('userManagement.title')}
      description={t('userManagement.subtitle')}
      actions={(
        <Button
          variant="primary"
          leftIcon={<Plus className="w-5 h-5" />}
          onClick={createInvitationModal.open}
        >
          {t('userManagement.inviteUser')}
        </Button>
      )}
    />
  );

  if (isLoading) {
    return (
      <div>
        {pageHeader}
        <div className="flex items-center justify-center min-h-[400px]">
          <Loading size="lg" text={t('userManagement.loading')} />
        </div>
      </div>
    );
  }

  // Error state
  if ((usersError && !users) || (invitationsError && !invitations)) {
    return (
      <div>
        {pageHeader}
        <ErrorState
          title={t('userManagement.loadError')}
          onRetry={() => { void refetchUsers(); void refetchInvitations(); }}
        />
      </div>
    );
  }

  const tabs: { key: TabType; label: string; count: number }[] = [
    { key: 'users', label: t('userManagement.tabs.users'), count: users?.length || 0 },
    {
      key: 'invitations',
      label: t('userManagement.tabs.invitations'),
      count: invitations?.length || 0,
    },
    ...(canManageRoles
      ? [{ key: 'roles' as TabType, label: t('userManagement.tabs.roles', 'Roles'), count: roles?.length || 0 }]
      : []),
  ];

  return (
    <div>
      {pageHeader}

      {/* Statistics Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <Card padding="sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-soft">
                {t('userManagement.stats.totalUsers')}
              </p>
              <p className="text-2xl font-bold text-heading">
                {users?.length || 0}
              </p>
            </div>
            <Users className="w-8 h-8 text-accent" />
          </div>
        </Card>

        <Card padding="sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-soft">
                {t('userManagement.stats.activeUsers')}
              </p>
              <p className="text-2xl font-bold text-heading">
                {users?.filter((u) => u.isActive).length || 0}
              </p>
            </div>
            <CheckCircle className="w-8 h-8 text-success-text" />
          </div>
        </Card>

        <Card padding="sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-soft">
                {t('userManagement.stats.pendingInvitations')}
              </p>
              <p className="text-2xl font-bold text-heading">
                {invitations?.length || 0}
              </p>
            </div>
            <Mail className="w-8 h-8 text-info-text" />
          </div>
        </Card>

        <Card padding="sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-soft">
                {t('userManagement.stats.inactiveUsers')}
              </p>
              <p className="text-2xl font-bold text-heading">
                {users?.filter((u) => !u.isActive).length || 0}
              </p>
            </div>
            <XCircle className="w-8 h-8 text-faint" />
          </div>
        </Card>
      </div>

      {/* Tab Navigation */}
      <Tabs
        className="mb-6"
        items={tabs.map((tab) => ({ id: tab.key, label: tab.label, count: tab.count }))}
        value={activeTab}
        onChange={setActiveTab}
        aria-label={t('userManagement.title')}
      />

      {/* Search */}
      {activeTab !== 'roles' && (
        <Card padding="sm" className="mb-6">
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="flex-1">
              <Input
                type="text"
                placeholder={
                  activeTab === 'users'
                    ? t('userManagement.searchUsersPlaceholder')
                    : t('userManagement.searchInvitationsPlaceholder')
                }
                leftIcon={<Search className="w-5 h-5 text-faint" />}
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
          </div>
        </Card>
      )}

      {/* Users Tab Content */}
      {activeTab === 'users' && (
        <Table>
          <TableHead>
            <tr>
              <TableHeaderCell>
                {t('userManagement.table.user')}
              </TableHeaderCell>
              <TableHeaderCell>
                {t('userManagement.table.role')}
              </TableHeaderCell>
              <TableHeaderCell>
                {t('userManagement.table.status')}
              </TableHeaderCell>
              <TableHeaderCell>
                {t('userManagement.table.lastLogin')}
              </TableHeaderCell>
              <TableHeaderCell align="right">
                {t('userManagement.table.actions')}
              </TableHeaderCell>
            </tr>
          </TableHead>
          <TableBody>
            {filteredUsers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5}>
                  <EmptyState
                    size="inline"
                    icon={<Users />}
                    title={searchTerm
                      ? t('userManagement.noUsersFound')
                      : t('userManagement.noUsers')}
                  />
                </TableCell>
              </TableRow>
            ) : (
              filteredUsers.map((user) => (
                <TableRow key={user.id} className="hover:bg-hover-soft">
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-accent-soft flex items-center justify-center">
                        <span className="text-on-accent-soft font-medium text-sm">
                          {user.username.charAt(0).toUpperCase()}
                        </span>
                      </div>
                      <div>
                        <p className="text-sm font-medium text-heading">
                          {user.username}
                        </p>
                        <p className="text-xs text-muted">{user.email}</p>
                        {isSuperAdmin && user.emailLinkEligible === false && (
                          <Badge tone="warning" icon={<AlertTriangle />} className="mt-1">
                            {t('userManagement.ssoNotConfirmed', 'Email not confirmed for SSO')}
                          </Badge>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge tone={getRoleBadgeTone(user.roleName || '')} icon={<Shield />}>
                      {user.roleDisplayName || user.roleName || t('userManagement.noRole')}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge tone={user.isActive ? 'success' : 'neutral'}>
                      {user.isActive
                        ? t('userManagement.status.active')
                        : t('userManagement.status.inactive')}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {user.lastLogin ? (
                      <div className="flex items-center gap-1 text-sm text-body">
                        <Clock className="w-4 h-4" />
                        {formatDistanceToNow(parseISO(user.lastLogin), {
                          addSuffix: true,
                        })}
                      </div>
                    ) : (
                      <span className="text-sm text-faint">
                        {t('userManagement.neverLoggedIn')}
                      </span>
                    )}
                  </TableCell>
                  <TableCell align="right">
                    <div className="flex items-center justify-end gap-2">
                      {/* Only a Super Admin can set email_link_eligible, and the
                          row only needs it while it is false (migration 227). */}
                      {isSuperAdmin && user.emailLinkEligible === false && (
                        <button
                          onClick={() => handleConfirmEmail(user)}
                          className="p-1.5 text-faint hover:text-warning-text hover:bg-warning-soft rounded-lg transition-colors"
                          title={t('userManagement.confirmEmailForSso', 'Confirm email for SSO')}
                          aria-label={t('userManagement.confirmEmailForSso', 'Confirm email for SSO') as string}
                        >
                          <MailCheck className="w-4 h-4" />
                        </button>
                      )}
                      <button
                        onClick={() => handleEditUser(user)}
                        className="p-1.5 text-faint hover:text-accent hover:bg-accent-soft rounded-lg transition-colors"
                        title={t('userManagement.editUser')}
                        aria-label={t('userManagement.editUser') as string}
                      >
                        <Edit className="w-4 h-4" />
                      </button>
                      {user.isActive ? (
                        <button
                          onClick={() => handleDeactivateUser(user)}
                          className="p-1.5 text-faint hover:text-danger-text hover:bg-danger-soft rounded-lg transition-colors"
                          title={t('userManagement.deactivateUser')}
                          aria-label={t('userManagement.deactivateUser') as string}
                        >
                          <UserX className="w-4 h-4" />
                        </button>
                      ) : (
                        <>
                          <button
                            onClick={() => handleActivateUser(user)}
                            className="p-1.5 text-faint hover:text-success-text hover:bg-success-soft rounded-lg transition-colors"
                            title={t('userManagement.activateUser', 'Reactivate user')}
                            aria-label={t('userManagement.activateUser', 'Reactivate user') as string}
                          >
                            <UserCheck className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleDeleteUser(user)}
                            className="p-1.5 text-faint hover:text-danger-text hover:bg-danger-soft rounded-lg transition-colors"
                            title={t('userManagement.deleteUser', 'Delete user permanently')}
                            aria-label={t('userManagement.deleteUser', 'Delete user permanently') as string}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      )}

      {/* Invitations Tab Content */}
      {activeTab === 'invitations' && (
        <Table>
          <TableHead>
            <tr>
              <TableHeaderCell>
                {t('userManagement.table.email')}
              </TableHeaderCell>
              <TableHeaderCell>
                {t('userManagement.table.role')}
              </TableHeaderCell>
              <TableHeaderCell>
                {t('userManagement.table.invitedBy')}
              </TableHeaderCell>
              <TableHeaderCell>
                {t('userManagement.table.expires')}
              </TableHeaderCell>
              <TableHeaderCell align="right">
                {t('userManagement.table.actions')}
              </TableHeaderCell>
            </tr>
          </TableHead>
          <TableBody>
            {filteredInvitations.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5}>
                  <EmptyState
                    size="inline"
                    icon={<Mail />}
                    title={searchTerm
                      ? t('userManagement.noInvitationsFound')
                      : t('userManagement.noInvitations')}
                    action={searchTerm ? undefined : (
                      <Button variant="outline" size="sm" leftIcon={<Plus className="w-4 h-4" />} onClick={createInvitationModal.open}>
                        {t('userManagement.inviteUser')}
                      </Button>
                    )}
                  />
                </TableCell>
              </TableRow>
            ) : (
              filteredInvitations.map((invitation) => {
                const isExpired = isPast(parseISO(invitation.expiresAt));
                return (
                  <TableRow key={invitation.id} className="hover:bg-hover-soft">
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-info-soft flex items-center justify-center">
                          <Mail className="w-5 h-5 text-info-text" />
                        </div>
                        <p className="text-sm font-medium text-heading">
                          {invitation.email}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge tone={getRoleBadgeTone(invitation.roleName || '')} icon={<Shield />}>
                        {invitation.roleName}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {invitation.invitedBy || '-'}
                    </TableCell>
                    <TableCell>
                      <span
                        className={`inline-flex items-center gap-1 text-sm ${
                          isExpired ? 'text-danger-text' : 'text-body'
                        }`}
                      >
                        <Clock className="w-4 h-4" />
                        {isExpired
                          ? t('userManagement.expired')
                          : formatDistanceToNow(parseISO(invitation.expiresAt), {
                              addSuffix: true,
                            })}
                      </span>
                    </TableCell>
                    <TableCell align="right">
                      <button
                        onClick={() => handleCancelInvitation(invitation)}
                        className="p-1.5 text-faint hover:text-danger-text hover:bg-danger-soft rounded-lg transition-colors"
                        title={t('userManagement.cancelInvitation')}
                        aria-label={t('userManagement.cancelInvitation') as string}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      )}

      {/* Roles Tab Content */}
      {activeTab === 'roles' && canManageRoles && <RoleManagementTab />}

      {/* Create Invitation Modal */}
      <CreateInvitationModal
        isOpen={createInvitationModal.isOpen}
        onClose={createInvitationModal.close}
        onSubmit={handleCreateInvitation}
        roles={roles || []}
        isLoading={createInvitationMutation.isPending}
      />

      {/* Edit User Modal */}
      <EditUserModal
        isOpen={editUserModal.isOpen}
        onClose={() => {
          editUserModal.close();
          setSelectedUser(null);
        }}
        onSubmit={handleUpdateUser}
        user={selectedUser}
        roles={roles || []}
        isLoading={updateUserMutation.isPending}
      />

      {/* Confirmation Dialog */}
      {confirmDialog && (
        <ConfirmDialog
          isOpen={confirmDialog.isOpen}
          onClose={() => setConfirmDialog(null)}
          onConfirm={handleConfirmAction}
          title={
            confirmDialog.type === 'deactivate' ? t('userManagement.confirmDeactivate.title')
            : confirmDialog.type === 'activate'  ? t('userManagement.confirmActivate.title', 'Reactivate user?')
            : confirmDialog.type === 'delete'    ? t('userManagement.confirmDelete.title', 'Delete user permanently?')
            : confirmDialog.type === 'confirmEmail' ? t('userManagement.confirmEmailForSsoDialog.title', 'Confirm this email for SSO?')
            : t('userManagement.confirmCancelInvitation.title')
          }
          message={
            confirmDialog.type === 'deactivate' ? t('userManagement.confirmDeactivate.message', { name: confirmDialog.name })
            : confirmDialog.type === 'activate'  ? t('userManagement.confirmActivate.message', 'Reactivate {{name}}? They will be able to log in again immediately.', { name: confirmDialog.name })
            : confirmDialog.type === 'delete'    ? t('userManagement.confirmDelete.message', 'Permanently delete {{name}}? This cannot be undone. Their pending invitations and API tokens will be removed; records they created elsewhere will be kept but de-attributed.', { name: confirmDialog.name })
            : confirmDialog.type === 'confirmEmail' ? t('userManagement.confirmEmailForSsoDialog.message', 'Confirm {{email}} as {{name}}\'s address? A single sign-on login that arrives with this verified email will then be linked to this account. The address itself is not changed. Only confirm it if you know it belongs to them.', { name: confirmDialog.name, email: confirmDialog.email })
            : t('userManagement.confirmCancelInvitation.message', { email: confirmDialog.name })
          }
          confirmText={
            confirmDialog.type === 'deactivate' ? t('userManagement.deactivate')
            : confirmDialog.type === 'activate'  ? t('userManagement.activate', 'Reactivate')
            : confirmDialog.type === 'delete'    ? t('userManagement.delete', 'Delete permanently')
            : confirmDialog.type === 'confirmEmail' ? t('userManagement.confirmEmail', 'Confirm email')
            // Not the generic `cancel` — that collides with ConfirmDialog's own
            // dismiss button, giving the dialog two "Cancel" buttons (QA I.04).
            : t('userManagement.cancelInvitation')
          }
          isLoading={
            confirmDialog.type === 'deactivate' ? deactivateUserMutation.isPending
            : confirmDialog.type === 'activate'  ? activateUserMutation.isPending
            : confirmDialog.type === 'delete'    ? deleteUserMutation.isPending
            : confirmDialog.type === 'confirmEmail' ? confirmEmailMutation.isPending
            : cancelInvitationMutation.isPending
          }
          variant={
            confirmDialog.type === 'activate' ? 'warning'
            : confirmDialog.type === 'deactivate' || confirmDialog.type === 'delete' ? 'danger'
            : 'warning'
          }
        />
      )}
    </div>
  );
};

UserManagementPage.displayName = 'UserManagementPage';
