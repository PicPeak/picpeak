import React from 'react';
import { useTranslation } from 'react-i18next';
import { Image, Settings } from 'lucide-react';
import type { Event } from '../../../types';
import type { EventDetailsTab } from './types';

interface EventTabsProps {
  event: Event;
  activeTab: EventDetailsTab;
  setActiveTab: (tab: EventDetailsTab) => void;
  showGuestsTab: boolean;
  /** The Settings draft has unsaved edits. */
  settingsDirty: boolean;
}

export const EventTabs: React.FC<EventTabsProps> = ({
  event,
  activeTab,
  setActiveTab,
  showGuestsTab,
  settingsDirty,
}) => {
  const { t } = useTranslation();

  const tabClass = (tab: EventDetailsTab) => `py-2 px-1 border-b-2 font-medium text-sm flex items-center gap-2 whitespace-nowrap ${
    activeTab === tab
      ? 'border-accent text-accent'
      : 'border-transparent text-muted hover:text-body hover:border-line-strong'
  }`;

  return (
    // The divider is an inset shadow, not a border: shadows paint under the
    // tabs, so the active tab's 2px underline covers it without hanging past
    // the row. A border needed the list pulled 1px over it (-mb-px), and
    // overflow-y-hidden then clipped that pixel off the underline.
    // overflow-y-hidden itself: with overflow-x set, overflow-y would be auto
    // too, and macOS showed a scrollbar for any hanging pixel. Settings at lg
    // puts its gap inside its panes, so they scroll right up to this line.
    // shrink-0: in that fill mode the page is a height-bounded flex column,
    // and overflow-y-hidden lets flex squeeze this row to nothing on a short
    // window before anything else.
    <div className={`shrink-0 shadow-[inset_0_-1px_0_var(--ui-line)] overflow-x-auto overflow-y-hidden ${activeTab === 'settings' ? 'mb-6 lg:mb-0' : 'mb-6'}`}>
      <nav className="flex gap-8" role="tablist">
        <button type="button" role="tab" aria-selected={activeTab === 'overview'} onClick={() => setActiveTab('overview')} className={tabClass('overview')}>
          {t('events.overview')}
        </button>
        <button type="button" role="tab" aria-selected={activeTab === 'photos'} onClick={() => setActiveTab('photos')} className={tabClass('photos')}>
          <Image className="w-4 h-4" />
          <span>{(event.video_count ?? 0) > 0 ? t('events.media', 'Media') : t('events.photos')}</span>
          {event.photo_count !== undefined && event.photo_count > 0 && (
            <span className="ml-1 px-2 py-0.5 text-xs font-medium bg-inset text-body rounded-full">{event.photo_count}</span>
          )}
        </button>
        {showGuestsTab && (
          <button type="button" role="tab" aria-selected={activeTab === 'guests'} onClick={() => setActiveTab('guests')} className={tabClass('guests')}>
            {t('admin.events.tabs.guestsFeedback', 'Guests & Feedback')}
          </button>
        )}
        <button type="button" role="tab" aria-selected={activeTab === 'settings'} onClick={() => setActiveTab('settings')} className={tabClass('settings')}>
          <Settings className="w-4 h-4" />
          <span>{t('admin.events.tabs.settings', 'Settings')}</span>
          {settingsDirty && (
            <span className="w-2 h-2 rounded-full bg-amber-500" aria-label={t('settings.saveBar.unsaved', 'You have unsaved changes')} />
          )}
        </button>
      </nav>
    </div>
  );
};
