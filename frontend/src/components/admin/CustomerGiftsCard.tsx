/**
 * Customer detail → Gifts (migration 343).
 *
 * The customer's gift history, a gift by hand, the "no gifts" switch and the
 * date the anniversaries count from. Admin-only, like everything about gifts.
 */
import React, { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Gift } from 'lucide-react';

import { Badge, Button, Card, ErrorState, LocalizedDateInput, Switch } from '../common';
import { useMutationWithToast } from '../../hooks';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { giftsService } from '../../services/gifts.service';
import { GiveGiftModal } from './GiftDialogs';

interface CustomerGiftsCardProps {
  customerId: number;
  canManage: boolean;
}

export const CustomerGiftsCard: React.FC<CustomerGiftsCardProps> = ({ customerId, canManage }) => {
  const { t } = useTranslation();
  const { format } = useLocalizedDate();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [startDate, setStartDate] = useState('');

  const queryKey = ['admin-customer-gifts', customerId];
  const { data, isError, refetch } = useQuery({
    queryKey,
    queryFn: () => giftsService.getCustomerGifts(customerId),
  });

  useEffect(() => { setStartDate(data?.startDateOverride || ''); }, [data?.startDateOverride]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey });
    queryClient.invalidateQueries({ queryKey: ['admin-gift-suggestions'] });
    queryClient.invalidateQueries({ queryKey: ['admin-gift-items'] });
  };

  const preferences = useMutationWithToast({
    mutationFn: (fields: { noGifts?: boolean; startDateOverride?: string | null }) => (
      giftsService.updateCustomerPreferences(customerId, fields)
    ),
    successMessage: t('gifts.customer.saved', 'Saved'),
    onSuccess: invalidate,
  });

  const undo = useMutationWithToast({
    mutationFn: (giftId: number) => giftsService.undo(giftId),
    successMessage: t('gifts.customer.undone', 'Entry undone'),
    onSuccess: invalidate,
  });

  return (
    <Card padding="lg">
      <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
        <h2 className="text-lg font-semibold text-heading flex items-center gap-2">
          <Gift className="w-5 h-5" /> {t('gifts.customer.title', 'Gifts')}
        </h2>
        {canManage && (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            {t('gifts.customer.add', 'Add gift')}
          </Button>
        )}
      </div>

      {isError && <ErrorState size="inline" onRetry={() => refetch()} />}

      {data && data.gifts.length === 0 && (
        <p className="text-sm text-soft">
          {t('gifts.customer.empty', 'No gifts yet.')}
        </p>
      )}

      {data && data.gifts.length > 0 && (
        <ul className="divide-y divide-line">
          {data.gifts.map((gift) => (
            <li key={gift.id} className="py-2 flex items-start justify-between gap-3">
              <div className={gift.undone ? 'opacity-60 min-w-0' : 'min-w-0'}>
                <p className="text-sm text-heading flex flex-wrap items-center gap-2">
                  {gift.status === 'declined'
                    ? t('gifts.customer.declined', 'Declined')
                    : gift.itemName}
                  {gift.milestoneYears && (
                    <Badge>{t('gifts.milestoneBadge', { count: gift.milestoneYears, defaultValue_one: '{{count}} year', defaultValue_other: '{{count}} years' })}</Badge>
                  )}
                  {gift.isOverride && <Badge tone="warning">{t('gifts.customer.override', 'Override')}</Badge>}
                  {gift.undone && <Badge>{t('gifts.customer.undoneBadge', 'Undone')}</Badge>}
                </p>
                <p className="text-xs text-soft">
                  {format(gift.giftDate)}{gift.note ? ` · ${gift.note}` : ''}
                </p>
              </div>
              {canManage && !gift.undone && (
                <Button variant="ghost" size="sm" onClick={() => undo.mutate(gift.id)} disabled={undo.isPending}>
                  {t('gifts.customer.undo', 'Undo')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {data && canManage && (
        <div className="mt-4 pt-4 border-t border-line grid grid-cols-1 md:grid-cols-2 gap-4">
          <Switch
            checked={data.noGifts}
            onChange={(noGifts) => preferences.mutate({ noGifts })}
            label={t('gifts.customer.noGifts', 'No gifts')}
            description={t('gifts.customer.noGiftsHint', 'Keeps this customer off every gift list.')}
          />
          <div className="flex items-end gap-2">
            <div className="flex-1 min-w-0">
              <LocalizedDateInput
                label={t('gifts.customer.startDate', 'Anniversaries count from')}
                helperText={t('gifts.customer.startDateHint', 'Leave empty to use the first paid invoice.')}
                value={startDate}
                onChange={setStartDate}
              />
            </div>
            {startDate !== (data.startDateOverride || '') && (
              <Button
                variant="outline"
                onClick={() => preferences.mutate({ startDateOverride: startDate || null })}
                disabled={preferences.isPending}
              >
                {t('common.save', 'Save')}
              </Button>
            )}
          </div>
        </div>
      )}

      <GiveGiftModal open={adding} onClose={() => setAdding(false)} customerId={customerId} />
    </Card>
  );
};
