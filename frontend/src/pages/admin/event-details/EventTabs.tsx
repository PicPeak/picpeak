import React from 'react';
import { useTranslation } from 'react-i18next';
import { Image, Settings } from 'lucide-react';
import type { Event } from '../../../types';
import type { EventDetailsTab } from './types';
import { Tabs, type TabItem } from '../../../components/common';

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

  const items: TabItem<EventDetailsTab>[] = [
    { id: 'overview', label: t('events.overview') },
    {
      id: 'photos',
      icon: <Image />,
      label: (event.video_count ?? 0) > 0 ? t('events.media', 'Media') : t('events.photos'),
      count: event.photo_count,
    },
    ...(showGuestsTab ? [{ id: 'guests' as const, label: t('admin.events.tabs.guestsFeedback', 'Guests & Feedback') }] : []),
    {
      id: 'settings',
      icon: <Settings />,
      label: t('admin.events.tabs.settings', 'Settings'),
      dirty: settingsDirty,
      dirtyLabel: t('settings.saveBar.unsaved', 'You have unsaved changes'),
    },
  ];

  // Settings at lg puts its gap inside its panes, so they scroll right up to
  // the tab line (STYLING.md › Split views).
  return (
    <Tabs
      items={items}
      value={activeTab}
      onChange={setActiveTab}
      className={activeTab === 'settings' ? 'mb-6 lg:mb-0' : 'mb-6'}
    />
  );
};
