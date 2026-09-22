/**
 * Admin → customer record → Activity (#1444).
 *
 * The customer's timeline — document uploads, shares, views, reviews and
 * deletions, plus account and group changes — newest first, from the
 * activity log. Labels come from admin.activities.<type>, the same keys the
 * dashboard's recent activity uses; an unknown type still renders, as its
 * key made readable.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useInfiniteQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';

import { Button, Card, Loading } from '../common';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { customerAdminService, type CustomerActivityEntry } from '../../services/customerAdmin.service';

const readable = (type: string) => type.replace(/^customer_/, '').replace(/_/g, ' ');

export const CustomerActivityCard: React.FC<{ customerId: number }> = ({ customerId }) => {
  const { t } = useTranslation();
  const { formatDateTime } = useLocalizedDate();
  const {
    data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ['admin-customer-activity', customerId],
    queryFn: ({ pageParam }) => customerAdminService.activity(customerId, pageParam),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextBeforeId,
  });

  const entries: CustomerActivityEntry[] = data?.pages.flatMap((p) => p.entries) ?? [];

  const label = (e: CustomerActivityEntry) => {
    // The shared labels name the customer ("Customer logged in: {{email}}").
    // On the customer's own record that is redundant, and the address is not
    // sent: drop the empty tail.
    const text = (t(`admin.activities.${e.type}`, {
      defaultValue: readable(e.type),
      ...e.metadata,
      email: '',
    }) as string).replace(/[\s:]+$/, '');
    return e.metadata.documentId ? `${text} (#${e.metadata.documentId})` : text;
  };

  return (
    <Card padding="lg">
      <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-1 flex items-center gap-2">
        <History className="w-5 h-5" />
        {t('customers.activity.title', 'Activity')}
      </h2>
      <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-4">
        {t('customers.activity.hint', 'What happened on this customer\'s account and documents, newest first.')}
      </p>
      {isLoading ? <Loading /> : isError ? (
        <p className="text-sm text-red-600 dark:text-red-400">
          {t('customers.activity.loadError', 'Could not load the activity.')}
        </p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {t('customers.activity.empty', 'No activity yet.')}
        </p>
      ) : (
        <>
          <ol className="divide-y divide-neutral-200 dark:divide-neutral-700">
            {entries.map((e) => (
              <li key={e.id} className="py-2 flex items-start justify-between gap-3 flex-wrap">
                <span className="text-sm text-neutral-900 dark:text-neutral-100 min-w-0 break-words">
                  {label(e)}
                  <span className="block text-xs text-neutral-500 dark:text-neutral-400">
                    {e.actorType === 'customer'
                      ? t('customers.activity.byCustomer', 'By the customer')
                      : e.actorType === 'admin'
                        ? t('customers.activity.byAdmin', 'By {{name}}', { name: e.actorName || t('customers.documents.anAdmin', 'an admin') })
                        : t('customers.activity.bySystem', 'Automatic')}
                  </span>
                </span>
                {e.at && (
                  <time dateTime={e.at} className="text-xs text-neutral-500 dark:text-neutral-400 whitespace-nowrap">
                    {formatDateTime(e.at)}
                  </time>
                )}
              </li>
            ))}
          </ol>
          {hasNextPage && (
            <div className="mt-3">
              <Button type="button" variant="outline" size="sm" onClick={() => fetchNextPage()} isLoading={isFetchingNextPage}>
                {t('customers.activity.more', 'Show older')}
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
};

export default CustomerActivityCard;
