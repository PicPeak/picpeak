import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Shield, Plus, Edit, Copy, Trash2, Lock, Users as UsersIcon, AlertTriangle } from 'lucide-react';

import { Button, Card, Loading } from '../common';
import { useMutationWithToast } from '../../hooks';
import { rolesService, type RoleWithPermissions } from '../../services/roles.service';
import { RoleEditorModal, type RoleEditorSave } from './RoleEditorModal';

const getRoleBadgeColor = (roleName: string): string => {
  switch (roleName?.toLowerCase()) {
    case 'super_admin':
      return 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800';
    case 'admin':
    case 'solo_photographer':
      return 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800';
    case 'editor':
      return 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 border-green-200 dark:border-green-800';
    default:
      return 'bg-inset text-body border-line';
  }
};

export const RoleManagementTab: React.FC = () => {
  const { t } = useTranslation();

  const [editor, setEditor] = useState<{ mode: 'create' | 'edit'; role: RoleWithPermissions | null } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RoleWithPermissions | null>(null);

  const { data: roles, isLoading: rolesLoading } = useQuery({
    queryKey: ['admin-roles-full'],
    queryFn: rolesService.getRoles,
  });
  const { data: catalog, isLoading: catalogLoading } = useQuery({
    queryKey: ['admin-permission-catalog'],
    queryFn: rolesService.getPermissionCatalog,
  });

  const invalidate: string[][] = [['admin-roles-full'], ['admin-roles']];

  const createMutation = useMutationWithToast({
    mutationFn: (payload: RoleEditorSave) =>
      rolesService.createRole({
        name: payload.name!,
        displayName: payload.displayName,
        description: payload.description,
        permissions: payload.permissions,
      }),
    invalidateKeys: invalidate,
    successMessage: t('roleEditor.created', 'Role created'),
    errorMessage: (e: Error) => e.message || t('roleEditor.saveError', 'Failed to save role'),
    onSuccess: () => setEditor(null),
  });

  const updateMutation = useMutationWithToast({
    mutationFn: ({ id, payload }: { id: number; payload: RoleEditorSave }) =>
      rolesService.updateRole(id, {
        displayName: payload.displayName,
        description: payload.description,
        permissions: payload.permissions,
      }),
    invalidateKeys: invalidate,
    successMessage: t('roleEditor.updated', 'Role updated'),
    errorMessage: (e: Error) => e.message || t('roleEditor.saveError', 'Failed to save role'),
    onSuccess: () => setEditor(null),
  });

  const deleteMutation = useMutationWithToast({
    mutationFn: (id: number) => rolesService.deleteRole(id),
    invalidateKeys: invalidate,
    successMessage: t('roleEditor.deleted', 'Role deleted'),
    errorMessage: (e: Error) => e.message || t('roleEditor.deleteError', 'Failed to delete role'),
    onSuccess: () => setDeleteTarget(null),
  });

  const handleSave = (payload: RoleEditorSave) => {
    if (editor?.mode === 'edit' && editor.role) {
      updateMutation.mutate({ id: editor.role.id, payload });
    } else {
      createMutation.mutate(payload);
    }
  };

  if (rolesLoading || catalogLoading) {
    return (
      <div className="flex items-center justify-center min-h-[300px]">
        <Loading size="lg" text={t('roleEditor.loading', 'Loading roles…')} />
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-soft">
          {t('roleEditor.subtitle', 'Define what each role can do. Start from a preset by cloning it, then trim or extend the permissions.')}
        </p>
        <Button
          variant="primary"
          leftIcon={<Plus className="w-4 h-4" />}
          onClick={() => setEditor({ mode: 'create', role: null })}
        >
          {t('roleEditor.newRole', 'New role')}
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {(roles || []).map((role) => {
          const isSuperAdmin = role.name === 'super_admin';
          return (
            <Card key={role.id} padding="sm" className="flex flex-col">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium border ${getRoleBadgeColor(role.name)}`}>
                      <Shield className="w-3 h-3" />
                      {role.displayName}
                    </span>
                    {role.isSystem && (
                      <span className="inline-flex items-center gap-1 text-[11px] text-faint">
                        <Lock className="w-3 h-3" />
                        {t('roleEditor.systemRole', 'System')}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs font-mono text-faint">{role.name}</p>
                  {role.description && (
                    <p className="mt-1 text-sm text-soft line-clamp-2">{role.description}</p>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-4 mt-3 text-xs text-muted">
                <span>{t('roleEditor.permCount', '{{count}} permissions', { count: role.permissions.length })}</span>
                <span className="flex items-center gap-1">
                  <UsersIcon className="w-3.5 h-3.5" />
                  {t('roleEditor.userCount', '{{count}} users', { count: role.userCount })}
                </span>
              </div>

              <div className="flex items-center gap-2 mt-3 pt-3 border-t border-line">
                <Button
                  variant="outline"
                  size="sm"
                  leftIcon={<Edit className="w-3.5 h-3.5" />}
                  onClick={() => setEditor({ mode: 'edit', role })}
                >
                  {isSuperAdmin ? t('roleEditor.view', 'View') : t('common.edit', 'Edit')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  leftIcon={<Copy className="w-3.5 h-3.5" />}
                  onClick={() => setEditor({ mode: 'create', role: { ...role, displayName: `${role.displayName} copy` } })}
                >
                  {t('roleEditor.clone', 'Clone')}
                </Button>
                {!role.isSystem && (
                  <Button
                    variant="outline"
                    size="sm"
                    leftIcon={<Trash2 className="w-3.5 h-3.5" />}
                    onClick={() => setDeleteTarget(role)}
                    className="text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30"
                  >
                    {t('common.delete', 'Delete')}
                  </Button>
                )}
              </div>
            </Card>
          );
        })}
      </div>

      {editor && (
        <RoleEditorModal
          isOpen
          mode={editor.mode}
          role={editor.role}
          catalog={catalog || []}
          isLoading={createMutation.isPending || updateMutation.isPending}
          onClose={() => setEditor(null)}
          onSave={handleSave}
        />
      )}

      {deleteTarget && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <Card className="w-full max-w-md">
            <div className="p-6">
              <div className="flex items-start gap-3 mb-4">
                <div className="p-2 rounded-full bg-red-100 dark:bg-red-900/40">
                  <AlertTriangle className="w-5 h-5 text-red-600 dark:text-red-400" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-heading">
                    {t('roleEditor.confirmDelete.title', 'Delete role?')}
                  </h2>
                  <p className="text-sm text-soft mt-1">
                    {deleteTarget.userCount > 0
                      ? t('roleEditor.confirmDelete.hasUsers', 'Reassign the {{count}} user(s) holding "{{name}}" before deleting it.', { count: deleteTarget.userCount, name: deleteTarget.displayName })
                      : t('roleEditor.confirmDelete.message', 'Permanently delete the "{{name}}" role? This cannot be undone.', { name: deleteTarget.displayName })}
                  </p>
                </div>
              </div>
              <div className="flex justify-end gap-3 mt-6">
                <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleteMutation.isPending}>
                  {t('common.cancel')}
                </Button>
                <Button
                  variant="primary"
                  onClick={() => deleteMutation.mutate(deleteTarget.id)}
                  isLoading={deleteMutation.isPending}
                  disabled={deleteTarget.userCount > 0}
                  className="bg-red-600 hover:bg-red-700 focus:ring-red-500"
                >
                  {t('common.delete', 'Delete')}
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
};

RoleManagementTab.displayName = 'RoleManagementTab';
