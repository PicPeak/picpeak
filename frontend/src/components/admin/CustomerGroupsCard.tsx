/**
 * Customer detail → Groups (#1443).
 *
 * The groups this customer is in, and a picker to change them. Saving sends
 * the whole set, so the server sees one replace rather than a sequence of
 * adds and removes.
 *
 * An archived group the customer already carries stays listed and stays
 * checked — it is history, and unchecking it is the way out. It is not
 * offered to a customer who isn't in it.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Tags } from 'lucide-react';

import { Button, Card } from '../common';
import { useMutationWithToast } from '../../hooks';
import { customerAdminService, type CustomerGroup } from '../../services/customerAdmin.service';
import { CustomerGroupChip } from './CustomerGroupChips';

interface CustomerGroupsCardProps {
  customerId: number;
  /** The groups from the customer record, so the card paints before its own fetch. */
  groups?: CustomerGroup[];
  canManage: boolean;
}

export const CustomerGroupsCard: React.FC<CustomerGroupsCardProps> = ({ customerId, groups, canManage }) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);

  const assigned = useMemo(() => groups || [], [groups]);
  useEffect(() => { setSelected(assigned.map((group) => group.id)); }, [assigned]);

  const { data: catalogue } = useQuery({
    queryKey: ['admin-customer-groups'],
    queryFn: () => customerAdminService.listGroups(true),
    enabled: editing,
  });

  const save = useMutationWithToast({
    mutationFn: () => customerAdminService.setCustomerGroups(customerId, selected),
    successMessage: t('customers.groups.assignSaved', 'Groups saved'),
    onSuccess: () => {
      setEditing(false);
      queryClient.invalidateQueries({ queryKey: ['admin-customer', customerId] });
      queryClient.invalidateQueries({ queryKey: ['admin-customers'] });
      queryClient.invalidateQueries({ queryKey: ['admin-customer-groups'] });
    },
  });

  // Live groups, plus any archived one this customer already carries.
  const options = useMemo(() => {
    const carried = new Set(assigned.map((group) => group.id));
    return (catalogue || []).filter((group) => !group.isArchived || carried.has(group.id));
  }, [catalogue, assigned]);

  return (
    <Card padding="lg">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-neutral-900 dark:text-neutral-100">
          <Tags className="h-5 w-5" /> {t('customers.detail.groupsSection', 'Groups')}
        </h2>
        {canManage && !editing && (
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            {t('customers.groups.change', 'Change groups')}
          </Button>
        )}
      </div>

      {!editing ? (
        assigned.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            {t('customers.groups.noneAssigned', 'This customer is in no group.')}
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {assigned.map((group) => <CustomerGroupChip key={group.id} group={group} />)}
          </div>
        )
      ) : (
        <div className="space-y-3">
          {options.length === 0 ? (
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              {t('customers.groups.emptyCatalogue', 'No groups yet. Create one under Customers → Groups.')}
            </p>
          ) : (
            <ul className="space-y-2">
              {options.map((group) => (
                <li key={group.id}>
                  <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200">
                    <input
                      type="checkbox"
                      checked={selected.includes(group.id)}
                      onChange={(e) => setSelected((current) => (
                        e.target.checked
                          ? [...current, group.id]
                          : current.filter((id) => id !== group.id)
                      ))}
                    />
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: group.color }} aria-hidden="true" />
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
          <div className="flex gap-2">
            <Button size="sm" onClick={() => save.mutate()} isLoading={save.isPending}>
              {t('common.save', 'Save')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => { setSelected(assigned.map((group) => group.id)); setEditing(false); }}
            >
              {t('common.cancel', 'Cancel')}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
};
