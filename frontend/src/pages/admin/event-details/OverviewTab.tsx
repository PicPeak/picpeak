import React from 'react';
import type { Event } from '../../../types';
import { FeedbackModerationPanel } from '../../../components/admin';
import { EventReminderOverrideCard } from '../../../components/admin/EventReminderOverrideCard';
import { SlideshowSettingsCard } from '../../../components/admin/SlideshowSettingsCard';
import { ShortUrlsCard } from '../../../components/admin/ShortUrlsCard';
import { useFeatureFlags } from '../../../contexts/FeatureFlagsContext';
import type { AdminPhoto } from '../../../services/photos.service';
import type { FeedbackSettings as FeedbackSettingsType } from '../../../services/feedback.service';
import type { EnabledTemplate } from '../../../services/cssTemplates.service';
import { ThemeConfig } from '../../../types/theme.types';
import type { EditFormState, EventDetailsTab } from './types';
import { EventInformationCard } from './EventInformationCard';
import { ShareLinkCard } from './ShareLinkCard';
import { ClientAccessCard } from './ClientAccessCard';
import { EventActionsCard } from './EventActionsCard';
import { PhotoStatisticsCard } from './PhotoStatisticsCard';
import { EventThemeSection } from './EventThemeSection';
import { ArchiveStatusCard } from './ArchiveStatusCard';

interface OverviewTabProps {
  event: Event;
  id: string | undefined;
  isEditing: boolean;
  editForm: EditFormState;
  setEditForm: React.Dispatch<React.SetStateAction<EditFormState>>;
  showNewPassword: boolean;
  setShowNewPassword: (show: boolean) => void;
  feedbackSettings: FeedbackSettingsType;
  setFeedbackSettings: React.Dispatch<React.SetStateAction<FeedbackSettingsType>>;
  categories: Array<{ id: number; name: string; slug: string }>;
  photos: AdminPhoto[];
  phoneFieldEnabled: boolean;
  daysUntilExpiration: number | null;
  refetchEvent: () => void;
  setActiveTab: (tab: EventDetailsTab) => void;
  setShowPasswordReset: (show: boolean) => void;
  setShowPublishDialog: (show: boolean) => void;
  setShowDuplicateDialog: (show: boolean) => void;
  onArchive: () => void;
  isArchiving: boolean;
  isPublishing: boolean;
  isDuplicating: boolean;
  currentTheme: ThemeConfig | null;
  setCurrentTheme: (theme: ThemeConfig | null) => void;
  currentPresetName: string;
  setCurrentPresetName: (name: string) => void;
  setThemeChanged: (changed: boolean) => void;
  cssTemplates: EnabledTemplate[];
}

export const OverviewTab: React.FC<OverviewTabProps> = ({
  event,
  id,
  isEditing,
  editForm,
  setEditForm,
  showNewPassword,
  setShowNewPassword,
  feedbackSettings,
  setFeedbackSettings,
  categories,
  photos,
  phoneFieldEnabled,
  daysUntilExpiration,
  refetchEvent,
  setActiveTab,
  setShowPasswordReset,
  setShowPublishDialog,
  setShowDuplicateDialog,
  onArchive,
  isArchiving,
  isPublishing,
  isDuplicating,
  currentTheme,
  setCurrentTheme,
  currentPresetName,
  setCurrentPresetName,
  setThemeChanged,
  cssTemplates
}) => {
  const { flags } = useFeatureFlags();

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
      {/* Left Column - Main Details */}
      <div className="space-y-6">
        {/* Event Information */}
        <EventInformationCard
          event={event}
          id={id}
          isEditing={isEditing}
          editForm={editForm}
          setEditForm={setEditForm}
          showNewPassword={showNewPassword}
          setShowNewPassword={setShowNewPassword}
          feedbackSettings={feedbackSettings}
          setFeedbackSettings={setFeedbackSettings}
          categories={categories}
          photos={photos}
          phoneFieldEnabled={phoneFieldEnabled}
          daysUntilExpiration={daysUntilExpiration}
        />

        {/* Share Link */}
        <ShareLinkCard event={event} setShowPasswordReset={setShowPasswordReset} />

        {/* Branded short URLs (#699). Sits between the canonical share-link
            card and the Client Access card — same "things you share with
            the customer" cluster. */}
        <ShortUrlsCard eventId={event.id} />

        {/* Client Access (#172) */}
        <ClientAccessCard event={event} refetchEvent={refetchEvent} />

        {/* Live Slideshow ("Diashow") link + live display settings (migrations 138/139).
            Gated behind the `slideshow` feature flag. */}
        {flags.slideshow && (
        <SlideshowSettingsCard
          eventId={event.id}
          slug={event.slug}
          isArchived={event.is_archived}
          initial={{
            show_share_token: event.show_share_token,
            show_interval_ms: event.show_interval_ms,
            show_transition: event.show_transition,
            show_transition_ms: event.show_transition_ms,
            show_watermark: event.show_watermark,
            show_colorfilter: event.show_colorfilter,
          }}
          onChanged={() => refetchEvent()}
        />
        )}

        {/* Pre-event reminder override (migration 143). Hidden when
            the reminderEmails master flag is off — the override here
            would never fire since the cron itself no-ops. */}
        {flags.reminderEmails && (
          <EventReminderOverrideCard
            eventId={event.id}
            initial={{
              event_reminder_disabled: event.event_reminder_disabled,
              event_reminder_offset_days: event.event_reminder_offset_days,
              event_reminder_body_override: event.event_reminder_body_override,
            }}
            onSaved={() => refetchEvent()}
          />
        )}

        {/* Actions */}
        {!event.is_archived && (
          <EventActionsCard
            event={event}
            onArchive={onArchive}
            isArchiving={isArchiving}
            setShowPublishDialog={setShowPublishDialog}
            isPublishing={isPublishing}
            setShowDuplicateDialog={setShowDuplicateDialog}
            isDuplicating={isDuplicating}
          />
        )}
      </div>

      {/* Right Column - Statistics, Theme, and Actions */}
      <div className="space-y-6">
        {/* Photo Statistics */}
        <PhotoStatisticsCard event={event} categories={categories} setActiveTab={setActiveTab} />

        {/* Theme & Style / Theme Display */}
        <EventThemeSection
          event={event}
          isEditing={isEditing}
          editForm={editForm}
          setEditForm={setEditForm}
          currentTheme={currentTheme}
          setCurrentTheme={setCurrentTheme}
          currentPresetName={currentPresetName}
          setCurrentPresetName={setCurrentPresetName}
          setThemeChanged={setThemeChanged}
          cssTemplates={cssTemplates}
        />

        {/* Feedback Moderation Panel */}
        {!event.is_archived && feedbackSettings?.feedback_enabled && (
          <FeedbackModerationPanel
            eventId={parseInt(id!)}
            compact={true}
            maxItems={3}
          />
        )}

        {/* Archive Status */}
        {event.is_archived ? (
          <ArchiveStatusCard event={event} id={id} />
        ) : null}
      </div>
    </div>
  );
};
