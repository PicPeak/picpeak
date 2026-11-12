/**
 * Everything the dashboard's Recent box shows, at full length. Mounted at
 * /customer/activity; the dashboard links here once it has more than it shows.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, History } from 'lucide-react';

import { Card, EmptyState, ErrorState, Loading } from '../../components/common';
import { customerService } from '../../services/customer.service';
import { RecentList } from './recentFeed';

export const CustomerActivityPage: React.FC = () => {
  const { t } = useTranslation();
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['customer-activity'],
    queryFn: () => customerService.getActivity(),
  });

  return (
    <div className="container py-6">
      <Link to="/customer/dashboard" className="inline-flex items-center gap-1 text-sm text-muted-theme hover:text-theme mb-4">
        <ArrowLeft className="w-4 h-4" />
        {t('customer.event.back', 'Back to your galleries')}
      </Link>
      <h1 className="text-2xl font-bold text-theme flex items-center gap-2 mb-6">
        <History className="w-6 h-6" />
        {t('customer.activity.title', 'Activity')}
      </h1>

      {isLoading ? (
        <div className="flex justify-center py-16"><Loading size="lg" /></div>
      ) : error || !data ? (
        <div className="rounded-xl border bg-surface border-border-token">
          <ErrorState
            title={t('customer.activity.loadError', 'Could not load the activity. Please try again.')}
            onRetry={() => { void refetch(); }}
            retrying={isFetching}
          />
        </div>
      ) : data.length === 0 ? (
        <Card padding="lg">
          <EmptyState size="inline" title={t('customer.activity.empty', 'Nothing has happened yet.')} />
        </Card>
      ) : (
        <div className="rounded-xl border overflow-hidden bg-surface border-border-token">
          <RecentList items={data} />
        </div>
      )}
    </div>
  );
};

export default CustomerActivityPage;
