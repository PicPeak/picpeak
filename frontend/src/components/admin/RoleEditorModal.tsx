import React, { useMemo, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Shield, Lock, Save } from 'lucide-react';

import { Button, Input, Card } from '../common';
import type { PermissionDef, RoleWithPermissions } from '../../services/roles.service';

export interface RoleEditorSave {
  name?: string;
  displayName: string;
  description?: string;
  permissions: string[];
}

interface RoleEditorModalProps {
  isOpen: boolean;
  mode: 'create' | 'edit';
  role: RoleWithPermissions | null; // null for create
  catalog: PermissionDef[];
  isLoading: boolean;
  onClose: () => void;
  onSave: (payload: RoleEditorSave) => void;
}

// Friendly labels for permission categories (fallback: the raw category name).
const CATEGORY_LABELS: Record<string, string> = {
  events: 'Events',
  photos: 'Photos',
  archives: 'Archives',
  analytics: 'Analytics',
  email: 'Email',
  branding: 'Branding',
  cms: 'CMS Pages',
  settings: 'Settings & Config',
  backup: 'Backup & Restore',
  users: 'Users & Roles',
  activity: 'Activity Logs',
  customers: 'Customers',
  quotes: 'Quotes',
  billing: 'Invoices',
  contracts: 'Contracts',
  accounting: 'Accounting',
  workflows: 'Workflows',
  whatsapp: 'WhatsApp',
  system: 'System',
};

function categoryLabel(cat: string): string {
  return CATEGORY_LABELS[cat] || cat.charAt(0).toUpperCase() + cat.slice(1);
}

export const RoleEditorModal: React.FC<RoleEditorModalProps> = ({
  isOpen,
  mode,
  role,
  catalog,
  isLoading,
  onClose,
  onSave,
}) => {
  const { t } = useTranslation();
  const isSuperAdmin = role?.name === 'super_admin';
  const readOnly = isSuperAdmin; // super_admin's permission set is immutable

  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [nameError, setNameError] = useState<string | undefined>();

  useEffect(() => {
    if (!isOpen) return;
    setName(mode === 'edit' ? (role?.name ?? '') : '');
    setDisplayName(role?.displayName ?? '');
    setDescription(role?.description ?? '');
    setSelected(new Set(role?.permissions ?? []));
    setNameError(undefined);
  }, [isOpen, mode, role]);

  // Group the catalog by category, preserving a stable order.
  const grouped = useMemo(() => {
    const map = new Map<string, PermissionDef[]>();
    for (const p of catalog) {
      if (!map.has(p.category)) map.set(p.category, []);
      map.get(p.category)!.push(p);
    }
    return Array.from(map.entries()).sort((a, b) => categoryLabel(a[0]).localeCompare(categoryLabel(b[0])));
  }, [catalog]);

  if (!isOpen) return null;

  const togglePerm = (permName: string) => {
    if (readOnly) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(permName)) next.delete(permName);
      else next.add(permName);
      return next;
    });
  };

  const toggleCategory = (perms: PermissionDef[], allSelected: boolean) => {
    if (readOnly) return;
    setSelected((prev) => {
      const next = new Set(prev);
      for (const p of perms) {
        if (allSelected) next.delete(p.name);
        else next.add(p.name);
      }
      return next;
    });
  };

  const handleSave = () => {
    if (mode === 'create') {
      const normalized = name.trim().toLowerCase();
      if (!/^[a-z][a-z0-9_]{1,48}$/.test(normalized)) {
        setNameError(t('roleEditor.nameError', 'Use lowercase letters, numbers and underscores (2–49 chars, starting with a letter).'));
        return;
      }
    }
    onSave({
      name: mode === 'create' ? name.trim().toLowerCase() : undefined,
      displayName: displayName.trim() || name.trim(),
      description: description.trim(),
      permissions: Array.from(selected),
    });
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <Card className="w-full max-w-3xl max-h-[90vh] flex flex-col">
        <div className="p-6 flex-1 overflow-y-auto">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Shield className="w-5 h-5 text-accent" />
              <h2 className="text-xl font-semibold text-heading">
                {mode === 'create'
                  ? t('roleEditor.createTitle', 'Create role')
                  : t('roleEditor.editTitle', 'Edit role: {{name}}', { name: role?.displayName })}
              </h2>
            </div>
            <button
              onClick={onClose}
              className="p-1 hover:bg-hover rounded-lg transition-colors"
              disabled={isLoading}
            >
              <X className="w-5 h-5 text-muted" />
            </button>
          </div>

          {readOnly && (
            <div className="mb-4 flex items-start gap-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800">
              <Lock className="w-4 h-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
              <p className="text-sm text-amber-700 dark:text-amber-300">
                {t('roleEditor.superAdminLocked', 'Super Admin always holds every permission and cannot be edited. It automatically gains new permissions as features are added.')}
              </p>
            </div>
          )}

          {/* Identity fields */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-2">
            <div>
              <label className="block text-sm font-medium text-body mb-1">
                {t('roleEditor.displayName', 'Display name')}
              </label>
              <Input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={t('roleEditor.displayNamePlaceholder', 'e.g. Photographer')}
                disabled={isLoading || readOnly}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-body mb-1">
                {t('roleEditor.key', 'Key (identifier)')}
              </label>
              <Input
                value={name}
                onChange={(e) => { setName(e.target.value); setNameError(undefined); }}
                placeholder="photographer"
                disabled={isLoading || mode === 'edit'}
              />
              {nameError && <p className="mt-1 text-sm text-red-600">{nameError}</p>}
              {mode === 'edit' && (
                <p className="mt-1 text-xs text-faint">
                  {t('roleEditor.keyLocked', 'The key is fixed once a role is created.')}
                </p>
              )}
            </div>
          </div>
          <div className="mb-4">
            <label className="block text-sm font-medium text-body mb-1">
              {t('roleEditor.description', 'Description')}
            </label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('roleEditor.descriptionPlaceholder', 'What this role is for')}
              disabled={isLoading || readOnly}
            />
          </div>

          {/* Permission matrix */}
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-body">
              {t('roleEditor.permissions', 'Permissions')}
            </h3>
            <span className="text-xs text-muted">
              {t('roleEditor.selectedCount', '{{count}} selected', { count: selected.size })}
            </span>
          </div>

          <div className="space-y-3">
            {grouped.map(([category, perms]) => {
              const selectedInCat = perms.filter((p) => selected.has(p.name)).length;
              const allSelected = selectedInCat === perms.length;
              return (
                <div key={category} className="border border-line rounded-lg overflow-hidden">
                  <div className="flex items-center justify-between px-3 py-2 bg-subtle border-b border-line">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-body">{categoryLabel(category)}</span>
                      <span className="text-xs text-faint">{selectedInCat}/{perms.length}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => toggleCategory(perms, allSelected)}
                      disabled={readOnly}
                      className="text-xs font-medium text-accent hover:underline disabled:opacity-40 disabled:no-underline"
                    >
                      {allSelected ? t('roleEditor.clearAll', 'Clear all') : t('roleEditor.selectAll', 'Select all')}
                    </button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4">
                    {perms.map((p) => {
                      const checked = selected.has(p.name);
                      return (
                        <label
                          key={p.name}
                          className={`flex items-start gap-2 px-3 py-2 border-t border-neutral-100 dark:border-neutral-700/60 ${readOnly ? 'cursor-default' : 'cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-700/40'}`}
                          title={p.description || undefined}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => togglePerm(p.name)}
                            disabled={readOnly}
                            className="mt-0.5 rounded border-line-strong text-accent focus:ring-accent"
                          />
                          <span className="min-w-0">
                            <span className="block text-sm text-body">{p.display_name}</span>
                            <span className="block text-[11px] text-faint font-mono truncate">{p.name}</span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex justify-end gap-3 p-4 border-t border-line">
          <Button type="button" variant="outline" onClick={onClose} disabled={isLoading}>
            {t('common.cancel')}
          </Button>
          {!readOnly && (
            <Button
              type="button"
              variant="primary"
              onClick={handleSave}
              isLoading={isLoading}
              leftIcon={<Save className="w-4 h-4" />}
            >
              {mode === 'create' ? t('roleEditor.create', 'Create role') : t('common.save', 'Save')}
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
};

RoleEditorModal.displayName = 'RoleEditorModal';
