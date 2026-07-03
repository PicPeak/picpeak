import React from 'react';
import { useTranslation } from 'react-i18next';
import { Image } from 'lucide-react';
import type { Event } from '../../../types';
import { Button, Card } from '../../../components/common';
import type { EventDetailsTab } from './types';

interface PhotoStatisticsCardProps {
  event: Event;
  categories: Array<{ id: number; name: string; slug: string }>;
  setActiveTab: (tab: EventDetailsTab) => void;
}

export const PhotoStatisticsCard: React.FC<PhotoStatisticsCardProps> = ({
  event,
  categories,
  setActiveTab
}) => {
  const { t } = useTranslation();

  return (
    <Card padding="md">
      <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">{t('events.photoStatistics')}</h2>

      <div className="space-y-3">
        <div className="flex items-center justify-between py-2 px-3 bg-neutral-50 dark:bg-neutral-700 rounded-lg">
          <span className="text-sm text-neutral-600 dark:text-neutral-400">{t('events.totalPhotos')}</span>
          <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{event.photo_count || 0}</span>
        </div>

        <div className="flex items-center justify-between py-2 px-3 bg-neutral-50 dark:bg-neutral-700 rounded-lg">
          <span className="text-sm text-neutral-600 dark:text-neutral-400">{t('events.totalSize')}</span>
          <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
            {event.total_size ? `${(event.total_size / (1024 * 1024)).toFixed(1)} MB` : '0 MB'}
          </span>
        </div>

        <div className="flex items-center justify-between py-2 px-3 bg-neutral-50 dark:bg-neutral-700 rounded-lg">
          <span className="text-sm text-neutral-600 dark:text-neutral-400">{t('events.categories')}</span>
          <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{categories.length}</span>
        </div>

        {event.total_views !== undefined && (
          <div className="flex items-center justify-between py-2 px-3 bg-neutral-50 dark:bg-neutral-700 rounded-lg">
            <span className="text-sm text-neutral-600 dark:text-neutral-400">{t('events.totalViews')}</span>
            <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{event.total_views || 0}</span>
          </div>
        )}

        {event.total_downloads !== undefined && (
          <div className="flex items-center justify-between py-2 px-3 bg-neutral-50 dark:bg-neutral-700 rounded-lg">
            <span className="text-sm text-neutral-600 dark:text-neutral-400">{t('events.totalDownloads')}</span>
            <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{event.total_downloads || 0}</span>
          </div>
        )}

        {event.unique_visitors !== undefined && (
          <div className="flex items-center justify-between py-2 px-3 bg-neutral-50 dark:bg-neutral-700 rounded-lg">
            <span className="text-sm text-neutral-600 dark:text-neutral-400">{t('events.uniqueVisitors')}</span>
            <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{event.unique_visitors || 0}</span>
          </div>
        )}
      </div>

      <div className="mt-4">
        <Button
          variant="outline"
          size="sm"
          leftIcon={<Image className="w-4 h-4" />}
          onClick={() => setActiveTab('photos')}
          className="w-full justify-center"
        >
          {t('events.managePhotos')}
        </Button>
      </div>
    </Card>
  );
};
