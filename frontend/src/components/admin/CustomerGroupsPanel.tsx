/**
 * Admin → Customers → Groups (#1443).
 *
 * The group catalogue: create, rename, recolour, reorder, archive, restore
 * and — only while nothing carries it — delete. A group that is still on
 * customers is archived instead; the server refuses the delete either way, so
 * no customer record ever depends on it.
 *
 * Reordering is up/down buttons rather than drag and drop: it works with a
 * keyboard and on a phone, which drag handles do not.
 */
import React, { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, Archive, ArchiveRestore, Plus, Trash2, X } from 'lucide-react';
import { toast } from 'react-toastify';

import { Button, Card, Input, Loading } from '../common';
import { useMutationWithToast } from '../../hooks';
import { customerAdminService, type CustomerGroup } from '../../services/customerAdmin.service';

/**
 * Eight colours that stay distinguishable on both themes' surfaces. The field
 * still accepts any hex, so this is a starting point rather than a cage.
 */
const PALETTE = ['#2563EB', '#15803D', '#B45309', '#B91C1C', '#7C3AED', '#0F766E', '#BE185D', '#4B5563'];

interface DraftState {
  name: string;
  description: string;
  color: string;
}

const EMPTY: DraftState = { name: '', description: '', color: PALETTE[0] };

/**
 * `canManage` is `customers.groups.manage`. Without it the catalogue is what
 * `customers.view` may read: the groups and their counts, and no control that
 * would only answer 403.
 */
export const CustomerGroupsPanel: React.FC<{ canManage: boolean }> = ({ canManage }) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<DraftState>(EMPTY);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [edit, setEdit] = useState<DraftState>(EMPTY);
  const [confirmDelete, setConfirmDelete] = useState<CustomerGroup | null>(null);

  const { data: groups, isLoading, error } = useQuery({
    queryKey: ['admin-customer-groups'],
    queryFn: () => customerAdminService.listGroups(true),
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['admin-customer-groups'] });
    // The overview shows the same groups as chips and filter pills.
    queryClient.invalidateQueries({ queryKey: ['admin-customers'] });
  };

  const createGroup = useMutationWithToast({
    mutationFn: () => customerAdminService.createGroup({ ...draft, description: draft.description || null }),
    successMessage: t('customers.groups.created', 'Group created'),
    onSuccess: () => { setDraft(EMPTY); setCreating(false); refresh(); },
  });

  const updateGroup = useMutationWithToast({
    mutationFn: (payload: { id: number; changes: Partial<CustomerGroup> }) =>
      customerAdminService.updateGroup(payload.id, {
        name: payload.changes.name,
        description: payload.changes.description,
        color: payload.changes.color,
        isArchived: payload.changes.isArchived,
      }),
    successMessage: t('customers.groups.saved', 'Group saved'),
    onSuccess: () => { setEditingId(null); refresh(); },
  });

  const deleteGroup = useMutationWithToast({
    mutationFn: (id: number) => customerAdminService.deleteGroup(id),
    successMessage: t('customers.groups.deleted', 'Group deleted'),
    onSuccess: () => { setConfirmDelete(null); refresh(); },
  });

  const reorder = useMutationWithToast({
    mutationFn: (orderedIds: number[]) => customerAdminService.reorderGroups(orderedIds),
    successMessage: t('customers.groups.reordered', 'Order saved'),
    onSuccess: refresh,
  });

  const ordered = useMemo(() => (groups || []).slice().sort((a, b) => a.sortOrder - b.sortOrder), [groups]);

  const move = (index: number, direction: -1 | 1) => {
    const next = ordered.slice();
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    reorder.mutate(next.map((group) => group.id));
  };

  const startEdit = (group: CustomerGroup) => {
    setEditingId(group.id);
    setEdit({ name: group.name, description: group.description || '', color: group.color });
  };

  const submitEdit = (group: CustomerGroup) => {
    if (!edit.name.trim()) {
      toast.error(t('customers.groups.nameRequired', 'A group needs a name'));
      return;
    }
    updateGroup.mutate({
      id: group.id,
      changes: { name: edit.name.trim(), description: edit.description || null, color: edit.color },
    });
  };

  if (isLoading) return <Loading />;
  if (error) {
    return (
      <Card padding="lg">
        <p className="text-sm text-red-600 dark:text-red-400">
          {t('customers.groups.loadError', 'The groups could not be loaded. Reload the page to try again.')}
        </p>
      </Card>
    );
  }

  return (
    <Card padding="lg">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
            {t('customers.groups.title', 'Groups')}
          </h2>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            {t('customers.groups.intro', 'Organise customers into groups. A customer can be in several, and the overview can be filtered by them.')}
          </p>
        </div>
        {canManage && !creating && (
          <Button variant="outline" size="sm" onClick={() => setCreating(true)} leftIcon={<Plus className="h-4 w-4" />}>
            {t('customers.groups.new', 'New group')}
          </Button>
        )}
      </div>

      {creating && (
        <form
          className="mb-4 space-y-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-700"
          onSubmit={(e) => { e.preventDefault(); createGroup.mutate(); }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label={t('customers.groups.name', 'Name')}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              maxLength={80}
              required
            />
            <Input
              label={t('customers.groups.description', 'Description')}
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              maxLength={500}
            />
          </div>
          <ColorPicker value={draft.color} onChange={(color) => setDraft({ ...draft, color })} />
          <div className="flex gap-2">
            <Button type="submit" size="sm" isLoading={createGroup.isPending} disabled={!draft.name.trim()}>
              {t('common.save', 'Save')}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => { setCreating(false); setDraft(EMPTY); }}>
              {t('common.cancel', 'Cancel')}
            </Button>
          </div>
        </form>
      )}

      {ordered.length === 0 ? (
        <p className="py-6 text-center text-sm text-neutral-500 dark:text-neutral-400">
          {t('customers.groups.empty', 'No groups yet. Create one to organise your customers.')}
        </p>
      ) : (
        <ul className="divide-y divide-neutral-200 dark:divide-neutral-700">
          {ordered.map((group, index) => (
            <li key={group.id} className="py-3">
              {editingId === group.id ? (
                <div className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Input
                      label={t('customers.groups.name', 'Name')}
                      value={edit.name}
                      onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                      maxLength={80}
                    />
                    <Input
                      label={t('customers.groups.description', 'Description')}
                      value={edit.description}
                      onChange={(e) => setEdit({ ...edit, description: e.target.value })}
                      maxLength={500}
                    />
                  </div>
                  <ColorPicker value={edit.color} onChange={(color) => setEdit({ ...edit, color })} />
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => submitEdit(group)} isLoading={updateGroup.isPending}>
                      {t('common.save', 'Save')}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>
                      {t('common.cancel', 'Cancel')}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: group.color }} aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
                      {group.name}
                      {group.isArchived && (
                        <span className="ml-2 text-xs font-normal text-neutral-500 dark:text-neutral-400">
                          {t('customers.groups.archived', 'Archived')}
                        </span>
                      )}
                    </p>
                    {group.description && (
                      <p className="truncate text-xs text-neutral-500 dark:text-neutral-400">{group.description}</p>
                    )}
                  </div>
                  <span className="text-xs text-neutral-500 dark:text-neutral-400">
                    {t('customers.groups.memberCount', {
                      count: group.memberCount || 0,
                      defaultValue_one: '{{count}} customer',
                      defaultValue_other: '{{count}} customers',
                    })}
                  </span>
                  {canManage && (
                  <div className="flex items-center gap-1">
                    <IconButton
                      label={t('customers.groups.moveUp', 'Move up')}
                      onClick={() => move(index, -1)}
                      disabled={index === 0 || reorder.isPending}
                    >
                      <ArrowUp className="h-4 w-4" />
                    </IconButton>
                    <IconButton
                      label={t('customers.groups.moveDown', 'Move down')}
                      onClick={() => move(index, 1)}
                      disabled={index === ordered.length - 1 || reorder.isPending}
                    >
                      <ArrowDown className="h-4 w-4" />
                    </IconButton>
                    <Button variant="ghost" size="sm" onClick={() => startEdit(group)}>
                      {t('common.edit', 'Edit')}
                    </Button>
                    <IconButton
                      label={group.isArchived
                        ? t('customers.groups.restore', 'Restore')
                        : t('customers.groups.archive', 'Archive')}
                      onClick={() => updateGroup.mutate({ id: group.id, changes: { isArchived: !group.isArchived } })}
                    >
                      {group.isArchived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
                    </IconButton>
                    <IconButton
                      label={t('customers.groups.delete', 'Delete')}
                      onClick={() => setConfirmDelete(group)}
                      disabled={(group.memberCount || 0) > 0}
                      title={(group.memberCount || 0) > 0
                        ? t('customers.groups.deleteBlocked', 'Customers are still in this group. Archive it, or remove it from them first.')
                        : undefined}
                    >
                      <Trash2 className="h-4 w-4" />
                    </IconButton>
                  </div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {confirmDelete && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950">
          <p className="text-sm text-red-800 dark:text-red-200">
            {t('customers.groups.confirmDelete', 'Delete "{{name}}"? No customer is removed by this.', { name: confirmDelete.name })}
          </p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="danger" isLoading={deleteGroup.isPending} onClick={() => deleteGroup.mutate(confirmDelete.id)}>
              {t('customers.groups.delete', 'Delete')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)} leftIcon={<X className="h-4 w-4" />}>
              {t('common.cancel', 'Cancel')}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
};

const IconButton: React.FC<{
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  children: React.ReactNode;
}> = ({ label, onClick, disabled, title, children }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    aria-label={label}
    title={title || label}
    className="rounded p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 disabled:cursor-not-allowed disabled:opacity-40 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
  >
    {children}
  </button>
);

const ColorPicker: React.FC<{ value: string; onChange: (color: string) => void }> = ({ value, onChange }) => {
  const { t } = useTranslation();
  return (
    <div>
      <span className="mb-1 block text-sm font-medium text-neutral-700 dark:text-neutral-300">
        {t('customers.groups.color', 'Colour')}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        {PALETTE.map((color) => (
          <button
            key={color}
            type="button"
            onClick={() => onChange(color)}
            aria-label={color}
            aria-pressed={value.toUpperCase() === color}
            className={`h-6 w-6 rounded-full border-2 ${
              value.toUpperCase() === color ? 'border-neutral-900 dark:border-neutral-100' : 'border-transparent'
            }`}
            style={{ backgroundColor: color }}
          />
        ))}
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          aria-label={t('customers.groups.customColor', 'Custom colour')}
          className="h-6 w-10 cursor-pointer rounded border border-neutral-200 bg-transparent dark:border-neutral-700"
        />
      </div>
    </div>
  );
};
