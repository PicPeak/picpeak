/**
 * Customers → bulk "Add to groups" / "Remove from groups" (#1443).
 *
 * Every change to the picked groups asks the server for a dry run, so the
 * admin confirms the effective change — "Adds 12 memberships, 3 customers
 * are already in VIP" — rather than an intention. The change itself is all
 * or nothing on the server; there is no undo, which is why the confirm
 * button states the consequence and is off while the preview is loading or
 * would change nothing.
 */
import React, { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

import { Button, Card } from '../common';
import { useMutationWithToast } from '../../hooks';
import {
  customerAdminService,
  type CustomerAccountSummary,
  type CustomerGroup,
} from '../../services/customerAdmin.service';
import { GroupDot } from './CustomerGroupChips';

interface BulkGroupAssignModalProps {
  mode: 'add' | 'remove';
  customers: CustomerAccountSummary[];
  /** The catalogue, archived groups included. */
  groups: CustomerGroup[];
  onClose: () => void;
  onDone: () => void;
}

export const BulkGroupAssignModal: React.FC<BulkGroupAssignModalProps> = ({
  mode, customers, groups, onClose, onDone,
}) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState<number[]>([]);
  const customerIds = useMemo(() => customers.map((c) => c.id), [customers]);

  // Adding offers the live groups; removing, every group the selection
  // carries — archived ones too, since removing is how they are emptied.
  const options = useMemo(() => {
    if (mode === 'add') return groups.filter((g) => !g.isArchived);
    const carried = new Set(customers.flatMap((c) => (c.groups || []).map((g) => g.id)));
    return groups.filter((g) => carried.has(g.id));
  }, [mode, groups, customers]);

  const payload = useMemo(() => ({
    customerIds,
    ...(mode === 'add' ? { addGroupIds: picked } : { removeGroupIds: picked }),
  }), [customerIds, mode, picked]);

  const preview = useQuery({
    queryKey: ['admin-customer-groups-bulk-preview', payload],
    queryFn: () => customerAdminService.bulkAssignGroups({ ...payload, dryRun: true }),
    enabled: picked.length > 0,
    staleTime: 0,
    gcTime: 0,
  });

  const apply = useMutationWithToast({
    mutationFn: () => customerAdminService.bulkAssignGroups(payload),
    successMessage: (result) => (mode === 'add'
      ? t('customers.groups.bulk.addedToast', {
        count: result.added,
        defaultValue_one: 'Added {{count}} membership',
        defaultValue_other: 'Added {{count}} memberships',
      })
      : t('customers.groups.bulk.removedToast', {
        count: result.removed,
        defaultValue_one: 'Removed {{count}} membership',
        defaultValue_other: 'Removed {{count}} memberships',
      })),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-customers'] });
      queryClient.invalidateQueries({ queryKey: ['admin-customer'] });
      queryClient.invalidateQueries({ queryKey: ['admin-customer-groups'] });
      onDone();
    },
  });

  const effect = preview.data ? (mode === 'add' ? preview.data.added : preview.data.removed) : 0;
  const nameOf = (groupId: number) => groups.find((g) => g.id === groupId)?.name || '';
  // "3 customers are already in VIP" / "2 customers are not in VIP": the
  // selected customers the change leaves as they are, per group.
  const unchanged = (preview.data?.perGroup || [])
    .map((row) => ({ groupId: row.groupId, count: customerIds.length - (mode === 'add' ? row.added : row.removed) }))
    .filter((row) => row.count > 0);

  const toggle = (id: number) => setPicked((current) => (
    current.includes(id) ? current.filter((value) => value !== id) : [...current, id]
  ));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <Card className="w-full max-w-md max-h-full overflow-y-auto" role="dialog" aria-modal="true" aria-labelledby="bulk-group-title">
        <div className="p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 id="bulk-group-title" className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
              {mode === 'add'
                ? t('customers.groups.bulk.addTitle', {
                  count: customerIds.length,
                  defaultValue_one: 'Add {{count}} customer to groups',
                  defaultValue_other: 'Add {{count}} customers to groups',
                })
                : t('customers.groups.bulk.removeTitle', {
                  count: customerIds.length,
                  defaultValue_one: 'Remove {{count}} customer from groups',
                  defaultValue_other: 'Remove {{count}} customers from groups',
                })}
            </h2>
            <button
              type="button"
              onClick={onClose}
              disabled={apply.isPending}
              aria-label={t('common.close', 'Close')}
              className="rounded-lg p-1 hover:bg-neutral-100 dark:hover:bg-neutral-700"
            >
              <X className="h-5 w-5 text-neutral-500 dark:text-neutral-400" />
            </button>
          </div>

          {options.length === 0 ? (
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              {mode === 'add'
                ? t('customers.groups.emptyCatalogue', 'No groups yet. Create one under Customers → Groups.')
                : t('customers.groups.bulk.noneCarried', 'None of the selected customers is in a group.')}
            </p>
          ) : (
            <ul className="max-h-60 space-y-2 overflow-y-auto">
              {options.map((group) => (
                <li key={group.id}>
                  <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200">
                    <input type="checkbox" checked={picked.includes(group.id)} onChange={() => toggle(group.id)} />
                    <GroupDot color={group.color} className="h-2.5 w-2.5" />
                    <span>{group.name}</span>
                    {group.isArchived && (
                      <span className="text-xs text-neutral-500 dark:text-neutral-400">
                        {t('customers.groups.archived', 'Archived')}
                      </span>
                    )}
                  </label>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-4 min-h-[2.5rem] text-sm text-neutral-700 dark:text-neutral-300" aria-live="polite">
            {picked.length > 0 && (preview.isFetching ? (
              <span className="text-neutral-500 dark:text-neutral-400">
                {t('customers.groups.bulk.previewing', 'Working out the change…')}
              </span>
            ) : preview.isError ? (
              <span className="text-red-600 dark:text-red-400">
                {t('customers.groups.bulk.previewError', 'The change could not be previewed. Close this and try again.')}
              </span>
            ) : preview.data && (
              <>
                <p>
                  {mode === 'add'
                    ? t('customers.groups.bulk.addsSummary', {
                      count: preview.data.added,
                      defaultValue_one: 'Adds {{count}} membership.',
                      defaultValue_other: 'Adds {{count}} memberships.',
                    })
                    : t('customers.groups.bulk.removesSummary', {
                      count: preview.data.removed,
                      defaultValue_one: 'Removes {{count}} membership.',
                      defaultValue_other: 'Removes {{count}} memberships.',
                    })}
                </p>
                {unchanged.map((row) => (
                  <p key={row.groupId} className="text-neutral-500 dark:text-neutral-400">
                    {mode === 'add'
                      ? t('customers.groups.bulk.alreadyIn', {
                        count: row.count,
                        name: nameOf(row.groupId),
                        defaultValue_one: '{{count}} customer is already in {{name}}.',
                        defaultValue_other: '{{count}} customers are already in {{name}}.',
                      })
                      : t('customers.groups.bulk.notIn', {
                        count: row.count,
                        name: nameOf(row.groupId),
                        defaultValue_one: '{{count}} customer is not in {{name}}.',
                        defaultValue_other: '{{count}} customers are not in {{name}}.',
                      })}
                  </p>
                ))}
              </>
            ))}
          </div>

          <div className="mt-4 flex justify-end gap-3">
            <Button variant="outline" onClick={onClose} disabled={apply.isPending}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={() => apply.mutate()}
              isLoading={apply.isPending}
              disabled={picked.length === 0 || preview.isFetching || !preview.data || effect === 0}
            >
              {mode === 'add'
                ? t('customers.groups.bulk.confirmAdd', {
                  count: effect,
                  defaultValue_one: 'Add {{count}} membership',
                  defaultValue_other: 'Add {{count}} memberships',
                })
                : t('customers.groups.bulk.confirmRemove', {
                  count: effect,
                  defaultValue_one: 'Remove {{count}} membership',
                  defaultValue_other: 'Remove {{count}} memberships',
                })}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
};
