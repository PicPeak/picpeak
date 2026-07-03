import React from 'react';
import { useTranslation } from 'react-i18next';
import { Image } from 'lucide-react';
import type { Event } from '../../../types';
import type { FeedbackSettings as FeedbackSettingsType } from '../../../services/feedback.service';
import type { EventDetailsTab } from './types';

interface EventTabsProps {
  event: Event;
  eventFeedbackSettings: FeedbackSettingsType | undefined;
  activeTab: EventDetailsTab;
  setActiveTab: (tab: EventDetailsTab) => void;
}

export const EventTabs: React.FC<EventTabsProps> = ({
  event,
  eventFeedbackSettings,
  activeTab,
  setActiveTab
}) => {
  const { t } = useTranslation();

  return (
    <div className="mb-6 border-b border-neutral-200 dark:border-neutral-700">
      <nav className="-mb-px flex space-x-8">
        <button
          onClick={() => setActiveTab('overview')}
          className={`py-2 px-1 border-b-2 font-medium text-sm ${
            activeTab === 'overview'
              ? 'border-accent text-accent'
              : 'border-transparent text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300 hover:border-neutral-300 dark:hover:border-neutral-600'
          }`}
        >
          {t('events.overview')}
        </button>
        <button
          onClick={() => setActiveTab('photos')}
          className={`py-2 px-1 border-b-2 font-medium text-sm flex items-center gap-2 ${
            activeTab === 'photos'
              ? 'border-accent text-accent'
              : 'border-transparent text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300 hover:border-neutral-300 dark:hover:border-neutral-600'
          }`}
        >
          <Image className="w-4 h-4" />
          <span>{t('events.photos')}</span>
          {event.photo_count !== undefined && event.photo_count > 0 && (
            <span className="ml-1 px-2 py-0.5 text-xs font-medium bg-neutral-100 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300 rounded-full">
              {event.photo_count}
            </span>
          )}
        </button>
        <button
          onClick={() => setActiveTab('categories')}
          className={`py-2 px-1 border-b-2 font-medium text-sm ${
            activeTab === 'categories'
              ? 'border-accent text-accent'
              : 'border-transparent text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300 hover:border-neutral-300 dark:hover:border-neutral-600'
          }`}
        >
          {t('events.categories')}
        </button>
        {eventFeedbackSettings?.identity_mode === 'guest' && (
          <button
            onClick={() => setActiveTab('guests')}
            className={`py-2 px-1 border-b-2 font-medium text-sm ${
              activeTab === 'guests'
                ? 'border-accent text-accent'
                : 'border-transparent text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300 hover:border-neutral-300 dark:hover:border-neutral-600'
            }`}
          >
            {t('admin.events.tabs.guests', 'Guests')}
          </button>
        )}
      </nav>
    </div>
  );
};
