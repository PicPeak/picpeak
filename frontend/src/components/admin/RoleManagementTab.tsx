import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Shield, Plus, Edit, Copy, Trash2, Lock, Users as UsersIcon } from 'lucide-react';

import { Badge, Button, Card, Loading, Modal, type BadgeTone } from '../common';
import { useMutationWithToast } from '../../hooks';
import { rolesService, type RoleWithPermissions } from '../../services/roles.service';
import { RoleEditorModal, type RoleEditorSave } from './RoleEditorModal';

const getRoleBadgeTone = (roleName: string): BadgeTone => {
  switch (roleName?.toLowerCase()) {
    case 'super_admin':
      return 'danger';
    case 'admin':
    case 'solo_photographer':
      return 'info';
    case 'editor':
      return 'success';
    default:
      return 'neutral';
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
                    <Badge tone={getRoleBadgeTone(role.name)} icon={<Shield />}>
                      {role.displayName}
                    </Badge>
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
                    className="text-danger-text hover:bg-danger-soft"
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

      <Modal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title={t('roleEditor.confirmDelete.title', 'Delete role?')}
        size="sm"
        closeOnBackdrop={false}
        footer={
          <>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleteMutation.isPending}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              isLoading={deleteMutation.isPending}
              disabled={!deleteTarget || deleteTarget.userCount > 0}
            >
              {t('common.delete', 'Delete')}
            </Button>
          </>
        }
      >
        {deleteTarget && (
          <p className="text-sm text-soft">
            {deleteTarget.userCount > 0
              ? t('roleEditor.confirmDelete.hasUsers', 'Reassign the {{count}} user(s) holding "{{name}}" before deleting it.', { count: deleteTarget.userCount, name: deleteTarget.displayName })
              : t('roleEditor.confirmDelete.message', 'Permanently delete the "{{name}}" role? This cannot be undone.', { name: deleteTarget.displayName })}
          </p>
        )}
      </Modal>
    </div>
  );
};

RoleManagementTab.displayName = 'RoleManagementTab';
