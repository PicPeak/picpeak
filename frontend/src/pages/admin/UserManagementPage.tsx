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
  X,
  AlertTriangle,
  Clock,
  Shield,
  Trash2,
  CheckCircle,
  XCircle,
} from 'lucide-react';
import { parseISO, isPast } from 'date-fns';

import { Button, Input, Card, Loading } from '../../components/common';
import { userManagementService } from '../../services/userManagement.service';
import type { AdminUser, AdminRole, AdminInvitation } from '../../types';
import { useLocalizedDate, useModal, useMutationWithToast } from "../../hooks";

type TabType = 'users' | 'invitations';

// Role badge colors
const getRoleBadgeColor = (roleName: string): string => {
  switch (roleName?.toLowerCase()) {
    case 'super_admin':
      return 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800';
    case 'admin':
      return 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800';
    case 'editor':
      return 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 border-green-200 dark:border-green-800';
    case 'viewer':
    default:
      return 'bg-neutral-100 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300 border-neutral-200 dark:border-neutral-600';
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

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <Card className="w-full max-w-md">
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
              {t('userManagement.createInvitation')}
            </h2>
            <button
              onClick={handleClose}
              className="p-1 hover:bg-neutral-100 dark:hover:bg-neutral-700 rounded-lg transition-colors"
              disabled={isLoading}
            >
              <X className="w-5 h-5 text-neutral-500 dark:text-neutral-400" />
            </button>
          </div>

          <form onSubmit={handleSubmit}>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
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
                  <p className="mt-1 text-sm text-red-600">{errors.email}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                  {t('userManagement.role')}
                </label>
                <select
                  value={roleId}
                  onChange={(e) => {
                    setRoleId(e.target.value ? Number(e.target.value) : '');
                    setErrors((prev) => ({ ...prev, role: undefined }));
                  }}
                  className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-accent-dark"
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
                  <p className="mt-1 text-sm text-red-600">{errors.role}</p>
                )}
              </div>
            </div>

            <div className="flex justify-end gap-3 mt-6">
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
                variant="primary"
                isLoading={isLoading}
                leftIcon={<Mail className="w-4 h-4" />}
              >
                {t('userManagement.sendInvitation')}
              </Button>
            </div>
          </form>
        </div>
      </Card>
    </div>
  );
};

// Modal component for editing users
interface EditUserModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (userId: number, roleId: number) => void;
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

  React.useEffect(() => {
    if (user?.roleId) {
      setRoleId(user.roleId);
    }
  }, [user]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !roleId) return;
    onSubmit(user.id, roleId as number);
  };

  const handleClose = () => {
    setRoleId('');
    onClose();
  };

  if (!isOpen || !user) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <Card className="w-full max-w-md">
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
              {t('userManagement.editUser')}
            </h2>
            <button
              onClick={handleClose}
              className="p-1 hover:bg-neutral-100 dark:hover:bg-neutral-700 rounded-lg transition-colors"
              disabled={isLoading}
            >
              <X className="w-5 h-5 text-neutral-500 dark:text-neutral-400" />
            </button>
          </div>

          <div className="mb-4 p-3 bg-neutral-50 dark:bg-neutral-700 rounded-lg">
            <p className="text-sm text-neutral-600 dark:text-neutral-300">
              {t('userManagement.editingUser')}: <strong>{user.username}</strong>
            </p>
            <p className="text-sm text-neutral-500 dark:text-neutral-400">{user.email}</p>
          </div>

          <form onSubmit={handleSubmit}>
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                {t('userManagement.role')}
              </label>
              <select
                value={roleId}
                onChange={(e) => setRoleId(e.target.value ? Number(e.target.value) : '')}
                className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-accent-dark"
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

            <div className="flex justify-end gap-3 mt-6">
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
                variant="primary"
                isLoading={isLoading}
                leftIcon={<Edit className="w-4 h-4" />}
              >
                {t('userManagement.saveChanges')}
              </Button>
            </div>
          </form>
        </div>
      </Card>
    </div>
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

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <Card className="w-full max-w-md">
        <div className="p-6">
          <div className="flex items-start gap-3 mb-4">
            <div
              className={`p-2 rounded-full ${
                variant === 'danger' ? 'bg-red-100 dark:bg-red-900/40' : 'bg-amber-100 dark:bg-amber-900/40'
              }`}
            >
              <AlertTriangle
                className={`w-5 h-5 ${
                  variant === 'danger' ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'
                }`}
              />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">{title}</h2>
              <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">{message}</p>
            </div>
          </div>

          <div className="flex justify-end gap-3 mt-6">
            <Button
              variant="outline"
              onClick={onClose}
              disabled={isLoading}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={onConfirm}
              isLoading={isLoading}
              className={
                variant === 'danger'
                  ? 'bg-red-600 hover:bg-red-700 focus:ring-red-500'
                  : ''
              }
            >
              {confirmText}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
};

export const UserManagementPage: React.FC = () => {
  const { t } = useTranslation();
  const { formatDistanceToNow } = useLocalizedDate()

  // State
  const [activeTab, setActiveTab] = useState<TabType>('users');
  const [searchTerm, setSearchTerm] = useState('');
  const createInvitationModal = useModal();
  const editUserModal = useModal();
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    type: 'deactivate' | 'activate' | 'delete' | 'cancelInvitation';
    id: number;
    name: string;
  } | null>(null);

  // Queries
  const {
    data: users,
    isLoading: usersLoading,
    error: usersError,
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
    errorMessage: (error: Error) => error.message || t('userManagement.invitationError'),
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
    mutationFn: ({ id, roleId }: { id: number; roleId: number }) =>
      userManagementService.updateUser(id, { roleId }),
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

  const handleUpdateUser = (userId: number, roleId: number) => {
    updateUserMutation.mutate({ id: userId, roleId });
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
    } else if (confirmDialog.type === 'cancelInvitation') {
      cancelInvitationMutation.mutate(confirmDialog.id);
    }
  };

  // Loading state
  const isLoading = usersLoading || rolesLoading || invitationsLoading;

  if (isLoading) {
    return (
      <div>
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
            {t('userManagement.title')}
          </h1>
          <p className="text-neutral-600 dark:text-neutral-400 mt-1">{t('userManagement.subtitle')}</p>
        </div>
        <div className="flex items-center justify-center min-h-[400px]">
          <Loading size="lg" text={t('userManagement.loading')} />
        </div>
      </div>
    );
  }

  // Error state
  if (usersError || invitationsError) {
    return (
      <div>
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
            {t('userManagement.title')}
          </h1>
          <p className="text-neutral-600 dark:text-neutral-400 mt-1">{t('userManagement.subtitle')}</p>
        </div>
        <div className="text-center py-12">
          <p className="text-red-600">{t('userManagement.loadError')}</p>
          <Button onClick={() => window.location.reload()} className="mt-4">
            {t('common.tryAgain')}
          </Button>
        </div>
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
  ];

  return (
    <div>
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
            {t('userManagement.title')}
          </h1>
          <p className="text-neutral-600 dark:text-neutral-400 mt-1">{t('userManagement.subtitle')}</p>
        </div>
        <Button
          variant="primary"
          leftIcon={<Plus className="w-5 h-5" />}
          onClick={createInvitationModal.open}
        >
          {t('userManagement.inviteUser')}
        </Button>
      </div>

      {/* Statistics Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <Card padding="sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                {t('userManagement.stats.totalUsers')}
              </p>
              <p className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
                {users?.length || 0}
              </p>
            </div>
            <Users className="w-8 h-8 text-accent" />
          </div>
        </Card>

        <Card padding="sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                {t('userManagement.stats.activeUsers')}
              </p>
              <p className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
                {users?.filter((u) => u.isActive).length || 0}
              </p>
            </div>
            <CheckCircle className="w-8 h-8 text-green-600" />
          </div>
        </Card>

        <Card padding="sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                {t('userManagement.stats.pendingInvitations')}
              </p>
              <p className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
                {invitations?.length || 0}
              </p>
            </div>
            <Mail className="w-8 h-8 text-blue-600" />
          </div>
        </Card>

        <Card padding="sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                {t('userManagement.stats.inactiveUsers')}
              </p>
              <p className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
                {users?.filter((u) => !u.isActive).length || 0}
              </p>
            </div>
            <XCircle className="w-8 h-8 text-neutral-400" />
          </div>
        </Card>
      </div>

      {/* Tab Navigation */}
      <div className="border-b border-neutral-200 dark:border-neutral-700 mb-6">
        <nav className="-mb-px flex gap-6">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`py-2 px-1 border-b-2 font-medium text-sm transition-colors flex items-center gap-2 ${
                activeTab === tab.key
                  ? 'border-accent text-accent'
                  : 'border-transparent text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300'
              }`}
            >
              {tab.label}
              <span
                className={`px-2 py-0.5 text-xs rounded-full ${
                  activeTab === tab.key
                    ? 'bg-accent-dark/15 text-accent-dark'
                    : 'bg-neutral-100 dark:bg-neutral-700 text-neutral-600 dark:text-neutral-400'
                }`}
              >
                {tab.count}
              </span>
            </button>
          ))}
        </nav>
      </div>

      {/* Search */}
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
              leftIcon={<Search className="w-5 h-5 text-neutral-400" />}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
        </div>
      </Card>

      {/* Users Tab Content */}
      {activeTab === 'users' && (
        <Card className="overflow-visible">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-neutral-50 dark:bg-neutral-800 border-b border-neutral-200 dark:border-neutral-700">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
                    {t('userManagement.table.user')}
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
                    {t('userManagement.table.role')}
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
                    {t('userManagement.table.status')}
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
                    {t('userManagement.table.lastLogin')}
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
                    {t('userManagement.table.actions')}
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white dark:bg-neutral-800 divide-y divide-neutral-200 dark:divide-neutral-700">
                {filteredUsers.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-12 text-center text-neutral-500 dark:text-neutral-400">
                      {searchTerm
                        ? t('userManagement.noUsersFound')
                        : t('userManagement.noUsers')}
                    </td>
                  </tr>
                ) : (
                  filteredUsers.map((user) => (
                    <tr key={user.id} className="hover:bg-neutral-50 dark:hover:bg-neutral-700/50">
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-full bg-accent-dark/15 flex items-center justify-center">
                            <span className="text-accent-dark font-medium text-sm">
                              {user.username.charAt(0).toUpperCase()}
                            </span>
                          </div>
                          <div>
                            <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                              {user.username}
                            </p>
                            <p className="text-xs text-neutral-500 dark:text-neutral-400">{user.email}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <span
                          className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium border ${getRoleBadgeColor(
                            user.roleName || ''
                          )}`}
                        >
                          <Shield className="w-3 h-3" />
                          {user.roleDisplayName || user.roleName || t('userManagement.noRole')}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                            user.isActive
                              ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300'
                              : 'bg-neutral-100 dark:bg-neutral-700 text-neutral-500 dark:text-neutral-400'
                          }`}
                        >
                          {user.isActive
                            ? t('userManagement.status.active')
                            : t('userManagement.status.inactive')}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        {user.lastLogin ? (
                          <div className="flex items-center gap-1 text-sm text-neutral-600 dark:text-neutral-300">
                            <Clock className="w-4 h-4" />
                            {formatDistanceToNow(parseISO(user.lastLogin), {
                              addSuffix: true,
                            })}
                          </div>
                        ) : (
                          <span className="text-sm text-neutral-400 dark:text-neutral-500">
                            {t('userManagement.neverLoggedIn')}
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => handleEditUser(user)}
                            className="p-1.5 text-neutral-400 hover:text-accent hover:bg-accent-dark/15 rounded-lg transition-colors"
                            title={t('userManagement.editUser')}
                          >
                            <Edit className="w-4 h-4" />
                          </button>
                          {user.isActive ? (
                            <button
                              onClick={() => handleDeactivateUser(user)}
                              className="p-1.5 text-neutral-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-lg transition-colors"
                              title={t('userManagement.deactivateUser')}
                            >
                              <UserX className="w-4 h-4" />
                            </button>
                          ) : (
                            <>
                              <button
                                onClick={() => handleActivateUser(user)}
                                className="p-1.5 text-neutral-400 hover:text-green-600 hover:bg-green-50 dark:hover:bg-green-900/30 rounded-lg transition-colors"
                                title={t('userManagement.activateUser', 'Reactivate user')}
                              >
                                <UserCheck className="w-4 h-4" />
                              </button>
                              <button
                                onClick={() => handleDeleteUser(user)}
                                className="p-1.5 text-neutral-400 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-lg transition-colors"
                                title={t('userManagement.deleteUser', 'Delete user permanently')}
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Invitations Tab Content */}
      {activeTab === 'invitations' && (
        <Card className="overflow-visible">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-neutral-50 dark:bg-neutral-800 border-b border-neutral-200 dark:border-neutral-700">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
                    {t('userManagement.table.email')}
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
                    {t('userManagement.table.role')}
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
                    {t('userManagement.table.invitedBy')}
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
                    {t('userManagement.table.expires')}
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">
                    {t('userManagement.table.actions')}
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white dark:bg-neutral-800 divide-y divide-neutral-200 dark:divide-neutral-700">
                {filteredInvitations.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-12 text-center text-neutral-500 dark:text-neutral-400">
                      {searchTerm
                        ? t('userManagement.noInvitationsFound')
                        : t('userManagement.noInvitations')}
                    </td>
                  </tr>
                ) : (
                  filteredInvitations.map((invitation) => {
                    const isExpired = isPast(parseISO(invitation.expiresAt));
                    return (
                      <tr key={invitation.id} className="hover:bg-neutral-50 dark:hover:bg-neutral-700/50">
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-full bg-blue-100 dark:bg-blue-900/40 flex items-center justify-center">
                              <Mail className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                            </div>
                            <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                              {invitation.email}
                            </p>
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <span
                            className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium border ${getRoleBadgeColor(
                              invitation.roleName || ''
                            )}`}
                          >
                            <Shield className="w-3 h-3" />
                            {invitation.roleName}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-sm text-neutral-600 dark:text-neutral-300">
                          {invitation.invitedBy || '-'}
                        </td>
                        <td className="px-6 py-4">
                          <span
                            className={`inline-flex items-center gap-1 text-sm ${
                              isExpired ? 'text-red-600 dark:text-red-400' : 'text-neutral-600 dark:text-neutral-300'
                            }`}
                          >
                            <Clock className="w-4 h-4" />
                            {isExpired
                              ? t('userManagement.expired')
                              : formatDistanceToNow(parseISO(invitation.expiresAt), {
                                  addSuffix: true,
                                })}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-right">
                          <button
                            onClick={() => handleCancelInvitation(invitation)}
                            className="p-1.5 text-neutral-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-lg transition-colors"
                            title={t('userManagement.cancelInvitation')}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

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
            : t('userManagement.confirmCancelInvitation.title')
          }
          message={
            confirmDialog.type === 'deactivate' ? t('userManagement.confirmDeactivate.message', { name: confirmDialog.name })
            : confirmDialog.type === 'activate'  ? t('userManagement.confirmActivate.message', 'Reactivate {{name}}? They will be able to log in again immediately.', { name: confirmDialog.name })
            : confirmDialog.type === 'delete'    ? t('userManagement.confirmDelete.message', 'Permanently delete {{name}}? This cannot be undone. Their pending invitations and API tokens will be removed; records they created elsewhere will be kept but de-attributed.', { name: confirmDialog.name })
            : t('userManagement.confirmCancelInvitation.message', { email: confirmDialog.name })
          }
          confirmText={
            confirmDialog.type === 'deactivate' ? t('userManagement.deactivate')
            : confirmDialog.type === 'activate'  ? t('userManagement.activate', 'Reactivate')
            : confirmDialog.type === 'delete'    ? t('userManagement.delete', 'Delete permanently')
            : t('userManagement.cancel')
          }
          isLoading={
            confirmDialog.type === 'deactivate' ? deactivateUserMutation.isPending
            : confirmDialog.type === 'activate'  ? activateUserMutation.isPending
            : confirmDialog.type === 'delete'    ? deleteUserMutation.isPending
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
