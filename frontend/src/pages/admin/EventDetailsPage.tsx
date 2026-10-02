import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useExpiryRefresh } from '../../hooks/useExpiryRefresh';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';

import { Button, Card, Loading } from '../../components/common';
import { PasswordResetModal, PublishGalleryDialog, SendGalleryEmailDialog, DuplicateEventDialog, EventRenameDialog, AdminGuestsList } from '../../components/admin';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { eventsService } from '../../services/events.service';
import { usePublicSettings } from '../../hooks/usePublicSettings';
import { useLeaveGuard, useUnsavedChanges } from '../../contexts/UnsavedChangesContext';
import { isGalleryPublic } from '../../utils/accessControl';
import { splitMediaCount } from '../../utils/mediaCounts';
import { photosService, AdminPhoto, type PhotoFilters as PhotoFilterParams, type FeedbackFilters } from '../../services/photos.service';
import { feedbackService, type FeedbackSettings } from '../../services/feedback.service';
import type { Event } from '../../types';
import type { ThemeConfig } from '../../types/theme.types';
import { safeParseDate, eventHasGuests } from './event-details/utils';
import type { EventDetailsTab } from './event-details/types';
import { EventDetailsHeader } from './event-details/EventDetailsHeader';
import { EventTabs } from './event-details/EventTabs';
import { OverviewTab } from './event-details/OverviewTab';
import { PhotosTab } from './event-details/PhotosTab';
import { EventSettingsTab } from './event-details/settings/EventSettingsTab';
import { useEventSettingsDraft } from './event-details/settings/useEventSettingsDraft';
import type { SettingsSectionKey } from './event-details/settings/draft';
import { EventFeedbackPanel } from './EventFeedbackPage';

const ALL_TAB_KEYS: EventDetailsTab[] = ['overview', 'photos', 'guests', 'settings'];
const SECTION_KEYS: SettingsSectionKey[] = ['general', 'access', 'downloads', 'guests', 'appearance', 'source', 'reminder', 'slideshow', 'faces', 'danger'];

function isValidTab(value: string | null): value is EventDetailsTab {
  return value !== null && (ALL_TAB_KEYS as string[]).includes(value);
}

function isValidSection(value: string | null): value is SettingsSectionKey {
  return value !== null && (SECTION_KEYS as string[]).includes(value);
}

export const EventDetailsPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const { confirmLeave } = useLeaveGuard();

  React.useEffect(() => {
    if (!id || isNaN(parseInt(id))) {
      navigate('/admin/events');
    }
  }, [id, navigate]);

  // ?tab=… and ?section=… are read on mount and kept in sync, so a copied
  // address lands on the same tab and Settings section. The retired
  // ?tab=categories opens Photos with the categories panel.
  const initialTabParam = searchParams.get('tab');
  const [openCategoriesOnMount] = useState(initialTabParam === 'categories');
  const [activeTab, setActiveTab] = useState<EventDetailsTab>(
    isValidTab(initialTabParam) ? initialTabParam : initialTabParam === 'categories' ? 'photos' : 'overview'
  );
  const [settingsSection, setSettingsSection] = useState<SettingsSectionKey>(
    isValidSection(searchParams.get('section')) ? (searchParams.get('section') as SettingsSectionKey) : 'general'
  );

  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', activeTab);
    if (activeTab === 'settings') next.set('section', settingsSection);
    else next.delete('section');
    if (next.toString() !== searchParams.toString()) setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, settingsSection]);

  // Reflect external URL changes (back/forward) back into local state.
  useEffect(() => {
    const urlTab = searchParams.get('tab');
    if (isValidTab(urlTab) && urlTab !== activeTab) setActiveTab(urlTab);
    const urlSection = searchParams.get('section');
    if (isValidSection(urlSection) && urlSection !== settingsSection) setSettingsSection(urlSection);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const openSettings = useCallback((section: SettingsSectionKey) => {
    setSettingsSection(section);
    setActiveTab('settings');
  }, []);

  const [showPasswordReset, setShowPasswordReset] = useState(false);
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [showPublishDialog, setShowPublishDialog] = useState(false);
  const [showSendEmailDialog, setShowSendEmailDialog] = useState(false);
  const [showDuplicateDialog, setShowDuplicateDialog] = useState(false);

  const [photoFilters, setPhotoFilters] = useState<PhotoFilterParams>({
    category_id: undefined as number | null | undefined,
    search: '',
    sort: 'date',
    order: 'desc' as 'asc' | 'desc'
  });

  const [feedbackFilters, setFeedbackFilters] = useState<FeedbackFilters>({
    minRating: null,
    hasLikes: false,
    hasFavorites: false,
    hasComments: false,
    colorLabels: [],
    myColorLabels: [],
    logic: 'AND'
  });

  // dataUpdatedAt doubles as the "password may have changed" signal for the
  // share card (#1271).
  const { data: event, isLoading: eventLoading, refetch: refetchEvent, dataUpdatedAt: eventUpdatedAt } = useQuery({
    queryKey: ['admin-event', id],
    queryFn: () => eventsService.getEvent(parseInt(id!)),
    enabled: !!id,
  });

  // Flip the expiry banner live when the timestamp passes with the page open (#909).
  const [, setExpiryTick] = useState(0);
  const bumpExpiryTick = useCallback(() => setExpiryTick((n) => n + 1), []);
  useExpiryRefresh([event?.expires_at], bumpExpiryTick);

  const { data: eventFeedbackSettings, isLoading: feedbackSettingsLoading } = useQuery({
    queryKey: ['admin-event-feedback-settings', id],
    queryFn: () => feedbackService.getEventFeedbackSettings(id!),
    enabled: !!id,
  });

  // Guests & Feedback: guests exist in guest identity mode and with uploader
  // names (#1561); feedback when it is switched on. Reading needs only
  // events.view, as the old feedback page did; the panels gate their actions.
  const hasGuests = eventHasGuests(event, eventFeedbackSettings);
  const showGuestsTab = hasGuests || !!eventFeedbackSettings?.feedback_enabled;

  useEffect(() => {
    if (feedbackSettingsLoading || eventLoading) return;
    if (activeTab === 'guests' && !showGuestsTab) setActiveTab('overview');
  }, [feedbackSettingsLoading, eventLoading, showGuestsTab, activeTab]);

  // Merge feedback filters into the photo query so the grid follows them.
  const combinedPhotoFilters: PhotoFilterParams = useMemo(() => ({
    ...photoFilters,
    hasLikes: feedbackFilters.hasLikes || undefined,
    hasFavorites: feedbackFilters.hasFavorites || undefined,
    hasComments: feedbackFilters.hasComments || undefined,
    minRating: feedbackFilters.minRating ?? undefined,
    colorLabels: feedbackFilters.colorLabels?.length ? feedbackFilters.colorLabels : undefined,
    myColorLabels: feedbackFilters.myColorLabels?.length ? feedbackFilters.myColorLabels : undefined,
    logic: feedbackFilters.logic,
  }), [photoFilters, feedbackFilters]);

  // Photos for the Photos tab and the Settings hero picker. Polls every 2s
  // while any photo is still being processed.
  const { data: photos = [], isLoading: photosLoading, isError: photosError, refetch: refetchPhotos } = useQuery({
    queryKey: ['admin-event-photos', id, combinedPhotoFilters],
    queryFn: () => photosService.getEventPhotos(parseInt(id!), combinedPhotoFilters),
    enabled: !!id && (activeTab === 'photos' || activeTab === 'settings'),
    refetchInterval: (query) => {
      const data = query.state.data as AdminPhoto[] | undefined;
      if (!Array.isArray(data)) return false;
      const inFlight = data.some(
        (p: any) => p.processing_status === 'pending' || p.processing_status === 'processing'
      );
      return inFlight ? 2000 : false;
    },
  });

  const { data: filterSummary } = useQuery({
    queryKey: ['admin-event-filter-summary', id],
    queryFn: () => photosService.getFilterSummary(parseInt(id!)),
    enabled: !!id && activeTab === 'photos',
  });

  // The photo / video select is offered when the event holds both. Read from
  // the event's counts, not from the rows on screen: those are what the select
  // filters, so an answer derived from them would hide the select the moment a
  // type is chosen. (The old derivation also never matched: the API reports a
  // photo as 'image', and it looked for 'photo'.)
  const eventMedia = splitMediaCount(event?.photo_count, event?.video_count);
  const showMediaFilter = eventMedia.photos > 0 && eventMedia.videos > 0;

  useEffect(() => {
    if (!showMediaFilter && photoFilters.media_type) {
      setPhotoFilters(prev => ({ ...prev, media_type: undefined }));
    }
  }, [showMediaFilter, photoFilters.media_type]);

  const { data: publicSettings } = usePublicSettings();
  const phoneFieldEnabled = publicSettings?.event_phone_field_enabled === true;

  const { data: categories = [] } = useQuery({
    queryKey: ['admin-event-categories', id],
    queryFn: async () => (await eventsService.getEventCategories(parseInt(id!))) || [],
    enabled: !!id,
  });

  const revealMutation = useMutation({
    mutationFn: () => eventsService.revealEvent(Number(id)),
    onSuccess: () => {
      toast.success(t('events.revealedToast', 'Gallery revealed — guests can see the photos now'));
      refetchEvent();
    },
    onError: () => toast.error(t('events.revealError', 'Failed to reveal the gallery')),
  });

  const archiveMutation = useMutation({
    mutationFn: () => eventsService.archiveEvent(parseInt(id!)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-event', id] });
      toast.success(t('toast.eventArchived'));
    },
    onError: () => toast.error(t('errors.somethingWentWrong')),
  });

  const deleteMutation = useMutation({
    mutationFn: () => eventsService.deleteEvent(parseInt(id!)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-events'] });
      toast.success(t('events.settingsTab.deleted', 'Gallery deleted'));
      navigate('/admin/events');
    },
    onError: () => toast.error(t('errors.somethingWentWrong')),
  });

  // Publish (Draft mode). Takes the admin-typed password so the
  // gallery_created email can carry the real plaintext (#627).
  const publishMutation = useMutation({
    mutationFn: (vars: { password?: string; notifyCustomer?: boolean }) =>
      eventsService.publishEvent(parseInt(id!), { password: vars.password, notifyCustomer: vars.notifyCustomer }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['admin-event', id] });
      queryClient.invalidateQueries({ queryKey: ['admin-events'] });
      toast.success(
        result?.notified_customer === false
          ? t('events.publishQuietSuccess', 'Gallery published. No email was sent.')
          : t('events.publishSuccess'),
      );
      setShowPublishDialog(false);
    },
    onError: () => toast.error(t('errors.somethingWentWrong')),
  });

  // Send the gallery email after the fact (#1235).
  const sendGalleryEmailMutation = useMutation({
    mutationFn: (password?: string) =>
      eventsService.sendGalleryEmail(parseInt(id!), password ? { password } : undefined),
    onSuccess: (result) => {
      // #1262 — queueing is not delivery; point at where the queue is visible.
      toast.success(
        `${t('events.sendGalleryEmail.success', {
          recipient: result.recipient,
          defaultValue: 'Gallery email queued to {{recipient}}.',
        })} ${t('events.emailQueuedHint', 'The queue processor sends it — check System health if it does not arrive.')}`,
      );
      setShowSendEmailDialog(false);
      // The send may have replaced the password (#627); refetch for #1271.
      queryClient.invalidateQueries({ queryKey: ['admin-event', id] });
    },
    onError: () => toast.error(t('errors.somethingWentWrong')),
  });

  // Duplicate (#626): a draft inheriting this gallery's configuration.
  const duplicateMutation = useMutation({
    mutationFn: (data: { event_name: string; event_date?: string; customer_name?: string; customer_email?: string }) =>
      eventsService.duplicateEvent(parseInt(id!), data),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['admin-events'] });
      toast.success(t('events.duplicateDialog.successToast', 'Gallery duplicated.'));
      setShowDuplicateDialog(false);
      navigate(`/admin/events/${result.id}`);
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.errors?.[0]?.msg || err?.response?.data?.error;
      toast.error(msg || t('errors.somethingWentWrong'));
    },
  });

  const extendMutation = useMutation({
    mutationFn: (days: number) => eventsService.extendExpiration(parseInt(id!), days),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-event', id] });
      toast.success(t('toast.saveSuccess'));
    },
    onError: () => toast.error(t('toast.saveError')),
  });

  if (eventLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loading size="lg" text={t('events.loadingEventDetails')} />
      </div>
    );
  }

  // A 404 (or any settled failure) leaves `event` undefined forever (QA 7.02).
  // A failed background refetch keeps the loaded event (and the draft).
  if (!event) {
    return (
      <Card padding="lg">
        <p className="text-heading">{t('events.notFound', 'Event not found')}</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate('/admin/events')}>
          {t('events.backToEvents')}
        </Button>
      </Card>
    );
  }

  const expiresAtDate = safeParseDate(event.expires_at);
  // Timestamp comparison, not truncated whole days (#909).
  const isExpired = expiresAtDate !== null && expiresAtDate.getTime() <= Date.now();
  const daysUntilExpiration = expiresAtDate
    ? Math.ceil((expiresAtDate.getTime() - Date.now()) / 86400000)
    : null;
  const isExpiring = !isExpired && daysUntilExpiration !== null && daysUntilExpiration > 0 && daysUntilExpiration <= 7;

  return (
    <EventDetailsLoaded
      event={event}
      eventFeedbackSettings={eventFeedbackSettings}
      branding={(publicSettings?.theme_config as ThemeConfig | undefined) ?? null}
    >
      {(settings) => (
        <div>
          <EventDetailsHeader
            event={event}
            setShowRenameDialog={setShowRenameDialog}
            setShowPublishDialog={setShowPublishDialog}
            setShowDuplicateDialog={async (show) => {
              // Duplicating opens the new gallery; ask before dropping edits.
              if (show && !(await confirmLeave())) return;
              setShowDuplicateDialog(show);
            }}
            onSendGalleryEmail={() => setShowSendEmailDialog(true)}
            isSendingGalleryEmail={sendGalleryEmailMutation.isPending}
            onArchive={() => archiveMutation.mutate()}
            isPublishing={publishMutation.isPending}
            onExtendExpiration={(days) => extendMutation.mutate(days)}
            daysUntilExpiration={daysUntilExpiration}
            isExpired={isExpired}
            isExpiring={isExpiring}
          />

          <EventTabs
            event={event}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            showGuestsTab={showGuestsTab}
            settingsDirty={settings.isDirty}
          />

          {activeTab === 'overview' && (
            <OverviewTab
              event={event}
              id={id}
              passwordVersion={eventUpdatedAt}
              feedbackSettings={eventFeedbackSettings}
              categories={categories}
              daysUntilExpiration={daysUntilExpiration}
              refetchEvent={refetchEvent}
              setActiveTab={setActiveTab}
              openSettings={openSettings}
              setShowPasswordReset={setShowPasswordReset}
              onSendGalleryEmail={() => setShowSendEmailDialog(true)}
              isSendingGalleryEmail={sendGalleryEmailMutation.isPending}
              onExtendExpiration={(days) => extendMutation.mutate(days)}
              isExtending={extendMutation.isPending}
              onRevealNow={() => revealMutation.mutate()}
            />
          )}

          {activeTab === 'photos' && (
            <PhotosTab
              event={event}
              id={id}
              photos={photos}
              photosLoading={photosLoading}
              photosError={photosError}
              refetchPhotos={refetchPhotos}
              categories={categories}
              photoFilters={photoFilters}
              setPhotoFilters={setPhotoFilters}
              feedbackFilters={feedbackFilters}
              setFeedbackFilters={setFeedbackFilters}
              filterSummary={filterSummary}
              showMediaFilter={showMediaFilter}
              hasVideos={eventMedia.hasVideos}
              initialCategoriesOpen={openCategoriesOnMount}
              onChangeFolder={() => openSettings('source')}
            />
          )}

          {activeTab === 'guests' && showGuestsTab && (
            <div className="space-y-8">
              {hasGuests && <AdminGuestsList eventId={parseInt(id!)} eventName={event.event_name} />}
              {eventFeedbackSettings?.feedback_enabled && <EventFeedbackPanel eventId={id!} />}
            </div>
          )}

          {activeTab === 'settings' && (
            <EventSettingsTab
              event={event}
              settings={settings}
              section={settingsSection}
              setSection={setSettingsSection}
              categories={categories}
              photos={photos}
              phoneFieldEnabled={phoneFieldEnabled}
              onArchive={() => archiveMutation.mutate()}
              isArchiving={archiveMutation.isPending}
              onDelete={() => deleteMutation.mutate()}
              isDeleting={deleteMutation.isPending}
              refetchEvent={refetchEvent}
            />
          )}

          {showPasswordReset && (
            <PasswordResetModal
              eventName={event.event_name}
              eventDate={event.event_date ?? undefined}
              eventType={event.event_type}
              onConfirm={async (sendEmail, password) => {
                const result = await eventsService.resetPassword(event.id, sendEmail, password);
                // refetch so the share card drops a revealed password (#1271)
                queryClient.invalidateQueries({ queryKey: ['admin-event', id] });
                return result;
              }}
              onClose={() => setShowPasswordReset(false)}
            />
          )}

          <EventRenameDialog
            isOpen={showRenameDialog}
            eventName={event.event_name}
            eventId={event.id}
            customerEmail={event.customer_email}
            onClose={() => setShowRenameDialog(false)}
            onRename={async (newName, resendEmail) => {
              const result = await eventsService.renameEvent(event.id, newName, resendEmail);
              if (result.success) {
                queryClient.invalidateQueries({ queryKey: ['admin-event', id] });
                queryClient.invalidateQueries({ queryKey: ['admin-events'] });
                toast.success(t('events.rename.success', 'Event renamed successfully!'));
              }
              return result;
            }}
            onValidate={(newName) => eventsService.validateRename(event.id, newName)}
          />

          {/* Publish (#627) — asks for the password so the gallery_created
              email carries the real plaintext. */}
          {showPublishDialog && (
            <PublishGalleryDialog
              eventName={event.event_name}
              requirePassword={!isGalleryPublic(event.require_password)}
              customerEmail={event.customer_email}
              customerPhone={event.customer_phone}
              assignedCustomerCount={((event as { customer_accounts?: Array<{ id: number }> }).customer_accounts || []).length}
              isPublishing={publishMutation.isPending}
              onConfirm={(password, notifyCustomer) => publishMutation.mutate({ password, notifyCustomer })}
              onClose={() => { if (!publishMutation.isPending) setShowPublishDialog(false); }}
            />
          )}

          {/* Send gallery email (#1235). Only the inline-email path carries
              the password; the account fallback sends a portal link. */}
          {showSendEmailDialog && (
            <SendGalleryEmailDialog
              eventName={event.event_name}
              recipient={event.customer_email}
              requirePassword={!!event.customer_email && !isGalleryPublic(event.require_password)}
              isSending={sendGalleryEmailMutation.isPending}
              onConfirm={(password) => sendGalleryEmailMutation.mutate(password)}
              onClose={() => { if (!sendGalleryEmailMutation.isPending) setShowSendEmailDialog(false); }}
            />
          )}

          {showDuplicateDialog && (
            <DuplicateEventDialog
              sourceEventName={event.event_name}
              isDuplicating={duplicateMutation.isPending}
              onConfirm={(data) => duplicateMutation.mutate(data)}
              onClose={() => { if (!duplicateMutation.isPending) setShowDuplicateDialog(false); }}
            />
          )}
        </div>
      )}
    </EventDetailsLoaded>
  );
};

EventDetailsPage.displayName = 'EventDetailsPage';

/**
 * Holds the Settings draft once the gallery has loaded, at page level so
 * switching tabs never drops it, and arms the leave guard for the whole page
 * — not only while the Settings tab (and its save bar) is on screen.
 */
const EventDetailsLoaded: React.FC<{
  event: Event;
  eventFeedbackSettings: FeedbackSettings | undefined;
  branding: ThemeConfig | null;
  children: (settings: ReturnType<typeof useEventSettingsDraft>) => React.ReactNode;
}> = ({ event, eventFeedbackSettings, branding, children }) => {
  const settings = useEventSettingsDraft({ event, feedbackSettings: eventFeedbackSettings, branding });
  useUnsavedChanges(settings.isDirty, settings.discard);
  return <>{children(settings)}</>;
};
