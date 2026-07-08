import React, { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { differenceInDays } from 'date-fns';
import { toast } from 'react-toastify';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';

import { Loading } from '../../components/common';
import { PasswordResetModal, PublishGalleryDialog, DuplicateEventDialog, EventRenameDialog, AdminGuestsList } from '../../components/admin';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { eventsService } from '../../services/events.service';
import { usePublicSettings } from '../../hooks/usePublicSettings';
import { isGalleryPublic, normalizeRequirePassword } from '../../utils/accessControl';
import { photosService, AdminPhoto, type PhotoFilters as PhotoFilterParams, type FeedbackFilters } from '../../services/photos.service';
import { feedbackService, FeedbackSettings as FeedbackSettingsType } from '../../services/feedback.service';
import { cssTemplatesService, type EnabledTemplate } from '../../services/cssTemplates.service';
import { ThemeConfig, GALLERY_THEME_PRESETS } from '../../types/theme.types';
import { safeParseDate } from './event-details/utils';
import { INITIAL_EDIT_FORM, type EditFormState, type EventDetailsTab } from './event-details/types';
import { EventDetailsHeader } from './event-details/EventDetailsHeader';
import { EventTabs } from './event-details/EventTabs';
import { OverviewTab } from './event-details/OverviewTab';
import { PhotosTab } from './event-details/PhotosTab';
import { CategoriesTab } from './event-details/CategoriesTab';

export const EventDetailsPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const { format } = useLocalizedDate();

  // Validate ID parameter
  React.useEffect(() => {
    if (!id || isNaN(parseInt(id))) {
      navigate('/admin/events');
    }
  }, [id, navigate]);

  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState<EditFormState>(INITIAL_EDIT_FORM);
  const [feedbackSettings, setFeedbackSettings] = useState<FeedbackSettingsType>({
    feedback_enabled: false,
    allow_ratings: true,
    allow_likes: true,
    allow_comments: true,
    allow_favorites: true,
    require_name_email: false,
    moderate_comments: true,
    show_feedback_to_guests: true,
    enable_rate_limiting: false,
    rate_limit_window_minutes: 15,
    rate_limit_max_requests: 10,
  });
  const [activeTab, setActiveTab] = useState<EventDetailsTab>('overview');
  const [showPasswordReset, setShowPasswordReset] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [showPublishDialog, setShowPublishDialog] = useState(false);
  const [showDuplicateDialog, setShowDuplicateDialog] = useState(false);
  const [currentTheme, setCurrentTheme] = useState<ThemeConfig | null>(null);
  const [currentPresetName, setCurrentPresetName] = useState<string>('default');
  // Tracks whether the admin actually interacted with the theme picker
  // during this edit session. Prevents the save handler from writing the
  // initial display state back to `events.color_theme`, which silently
  // overwrote branding inheritance on events with a NULL color_theme
  // (API-created events — #550 follow-up).
  const [themeChanged, setThemeChanged] = useState(false);
  const [cssTemplates, setCssTemplates] = useState<EnabledTemplate[]>([]);

  // Fetch CSS templates when component mounts or editing starts
  useEffect(() => {
    if (isEditing) {
      cssTemplatesService.getEnabledTemplates()
        .then(setCssTemplates)
        .catch(err => console.error('Failed to load CSS templates:', err));
    }
  }, [isEditing]);

  // Photo filters state
  const [photoFilters, setPhotoFilters] = useState<PhotoFilterParams>({
    category_id: undefined as number | null | undefined,
    search: '',
    sort: 'date',
    order: 'desc' as 'asc' | 'desc'
  });

  // Feedback filters state for export
  const [feedbackFilters, setFeedbackFilters] = useState<FeedbackFilters>({
    minRating: null,
    hasLikes: false,
    hasFavorites: false,
    hasComments: false,
    logic: 'AND'
  });

  // Fetch event details
  const { data: event, isLoading: eventLoading, refetch: refetchEvent } = useQuery({
    queryKey: ['admin-event', id],
    queryFn: () => eventsService.getEvent(parseInt(id!)),
    enabled: !!id,
  });

  // Fetch feedback settings
  const { data: eventFeedbackSettings } = useQuery({
    queryKey: ['admin-event-feedback-settings', id],
    queryFn: () => feedbackService.getEventFeedbackSettings(id!),
    enabled: !!id,
  });

  // Update local feedback settings when fetched from server
  useEffect(() => {
    if (eventFeedbackSettings) {
      setFeedbackSettings(eventFeedbackSettings);
    }
  }, [eventFeedbackSettings]);

  // Statistics are now fetched with the event details from the admin API

  // Merge feedback filters into photo query params so the grid reflects
  // the Has Likes / Has Favorites / Has Comments / min rating checkboxes.
  const combinedPhotoFilters: PhotoFilterParams = useMemo(() => ({
    ...photoFilters,
    hasLikes: feedbackFilters.hasLikes || undefined,
    hasFavorites: feedbackFilters.hasFavorites || undefined,
    hasComments: feedbackFilters.hasComments || undefined,
    minRating: feedbackFilters.minRating ?? undefined,
    logic: feedbackFilters.logic,
  }), [photoFilters, feedbackFilters]);

  // Fetch photos (needed for both photos tab and hero photo selector).
  // While any photo is still in pending/processing state we poll every
  // 2s so the admin grid auto-updates as the background worker drains
  // the queue. Once everything is complete/failed the polling stops.
  const { data: photos = [], isLoading: photosLoading, refetch: refetchPhotos } = useQuery({
    queryKey: ['admin-event-photos', id, combinedPhotoFilters],
    queryFn: () => photosService.getEventPhotos(parseInt(id!), combinedPhotoFilters),
    enabled: !!id && (activeTab === 'photos' || isEditing),
    refetchInterval: (query) => {
      const data = query.state.data as AdminPhoto[] | undefined;
      if (!Array.isArray(data)) return false;
      const inFlight = data.some(
        (p: any) => p.processing_status === 'pending' || p.processing_status === 'processing'
      );
      return inFlight ? 2000 : false;
    },
  });

  // Fetch filter summary for feedback filters
  const { data: filterSummary } = useQuery({
    queryKey: ['admin-event-filter-summary', id],
    queryFn: () => photosService.getFilterSummary(parseInt(id!)),
    enabled: !!id && activeTab === 'photos',
  });

  const mediaTypes = useMemo(() => {
    const types = new Set<'photo' | 'video'>();
    photos.forEach((p) => {
      const mediaType = (p.media_type as 'photo' | 'video' | undefined)
        || ((p.mime_type && String(p.mime_type).startsWith('video/')) || p.type === 'video' ? 'video' : 'photo');
      if (mediaType === 'video' || mediaType === 'photo') {
        types.add(mediaType);
      }
    });
    return types;
  }, [photos]);

  const showMediaFilter = mediaTypes.has('photo') && mediaTypes.has('video');

  useEffect(() => {
    if (!showMediaFilter && photoFilters.media_type) {
      setPhotoFilters(prev => ({ ...prev, media_type: undefined }));
    }
  }, [showMediaFilter, photoFilters.media_type]);

  const { data: publicSettings } = usePublicSettings();
  const phoneFieldEnabled = publicSettings?.event_phone_field_enabled === true;

  // Fetch categories for the event
  const { data: categories = [] } = useQuery({
    queryKey: ['admin-event-categories', id],
    queryFn: async () => {
      const response = await eventsService.getEventCategories(parseInt(id!));
      return response || [];
    },
    enabled: !!id,
  });

  // Update mutation
  const updateMutation = useMutation({
    mutationFn: (data: any) => eventsService.updateEvent(parseInt(id!), data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-event', id] });
      toast.success(t('toast.eventUpdated'));
      setIsEditing(false);
    },
    onError: (error: any) => {
      if (error.response?.data?.errors) {
        const errorMessage = error.response.data.errors[0].msg + ' (field: ' + error.response.data.errors[0].path + ')';
        toast.error(errorMessage);
      } else {
        toast.error(error.response?.data?.error || t('toast.saveError'));
      }
    },
  });

  // Archive mutation
  const archiveMutation = useMutation({
    mutationFn: () => eventsService.archiveEvent(parseInt(id!)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-event', id] });
      toast.success(t('toast.eventArchived'));
    },
    onError: () => {
      toast.error(t('errors.somethingWentWrong'));
    },
  });

  // Publish mutation (Draft mode). Accepts the admin-typed password so the
  // gallery_created email can carry the real plaintext (#627).
  const publishMutation = useMutation({
    mutationFn: (password?: string) =>
      eventsService.publishEvent(parseInt(id!), password ? { password } : undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-event', id] });
      queryClient.invalidateQueries({ queryKey: ['admin-events'] });
      toast.success(t('events.publishSuccess'));
      setShowPublishDialog(false);
    },
    onError: () => {
      toast.error(t('errors.somethingWentWrong'));
    },
  });

  // Duplicate mutation (#626). Backend creates a draft inheriting branding +
  // behaviour + categories from the source; we navigate to the new event so
  // the admin can finish configuring + publish.
  const duplicateMutation = useMutation({
    mutationFn: (data: {
      event_name: string;
      event_date?: string;
      customer_name?: string;
      customer_email?: string;
    }) => eventsService.duplicateEvent(parseInt(id!), data),
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

  // Extend expiration mutation
  const extendMutation = useMutation({
    mutationFn: (days: number) => {
      return eventsService.extendExpiration(parseInt(id!), days);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-event', id] });
      toast.success(t('toast.saveSuccess'));
    },
    onError: () => {
      toast.error(t('toast.saveError'));
    },
  });

  if (eventLoading || !event) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loading size="lg" text={t('events.loadingEventDetails')} />
      </div>
    );
  }

  const expiresAtDate = safeParseDate(event.expires_at);
  const daysUntilExpiration = expiresAtDate ? differenceInDays(expiresAtDate, new Date()) : null;
  const isExpired = daysUntilExpiration !== null && daysUntilExpiration <= 0;
  const isExpiring = daysUntilExpiration !== null && daysUntilExpiration > 0 && daysUntilExpiration <= 7;

  const handleStartEdit = () => {
    setEditForm({
      welcome_message: event.welcome_message || '',
      color_theme: event.color_theme || '',
      css_template_id: event.css_template_id || null,
      expires_at: expiresAtDate ? format(expiresAtDate, 'yyyy-MM-dd') : '',
      allow_user_uploads: event.allow_user_uploads || false,
      upload_category_id: event.upload_category_id || null,
      hero_photo_id: event.hero_photo_id || null,
      customer_name: event.customer_name || '',
      customer_email: event.customer_email || '',
      customer_phone: event.customer_phone || '',
      source_mode: event.source_mode === 'reference' ? 'reference' : 'managed',
      external_path: event.external_path || '',
      require_password: normalizeRequirePassword(event.require_password),
      new_password: '',
      confirm_new_password: '',
      // Load protection settings from event
      protection_level: event.protection_level || 'standard',
      disable_right_click: event.disable_right_click ?? true,
      allow_downloads: event.allow_downloads ?? true,
      watermark_downloads: event.watermark_downloads ?? false,
      allow_presigned_download: (event as { allow_presigned_download?: boolean }).allow_presigned_download ?? false,
      enable_devtools_protection: event.enable_devtools_protection ?? true,
      use_canvas_rendering: event.use_canvas_rendering ?? false,
      // Load hero logo settings from event. Preserve null = "inherit global"
      // (#756) — don't collapse it to true, or saving would snapshot an override.
      hero_logo_visible: event.hero_logo_visible ?? null,
      // Preserve null = "inherit global size" (#756) — don't collapse to medium.
      hero_logo_size: event.hero_logo_size ?? null,
      hero_logo_position: event.hero_logo_position || 'top',
      // Hero image anchor position (#162)
      hero_image_anchor: event.hero_image_anchor || 'center',
      // Photo cap
      photo_cap: event.photo_cap || 0,
      // Default photo sort
      default_photo_sort: event.default_photo_sort || 'upload_date_desc',
      // Per-event promotional override (#440)
      promo_mode: ((event as { promo_mode?: 'inherit' | 'custom' | 'off' }).promo_mode) || 'inherit',
      promo_markdown: (event as { promo_markdown?: string }).promo_markdown || '',
      // Customer accounts (#354). The backend returns
      // `customer_accounts: [{ id, email, display_name, ... }]`; map to
      // the picker's shape.
      customer_accounts: ((event as { customer_accounts?: Array<{ id: number; email: string; display_name?: string | null }> }).customer_accounts || [])
        .map((c) => ({ id: c.id, email: c.email, displayName: c.display_name ?? null })),
      // Per-event social-share opt-in (#474). Coerce explicitly so
      // SQLite's 0/1 and Postgres's true/false both render the switch
      // in the right state on first paint.
      og_image_share_enabled: event.og_image_share_enabled === true,
    });

    setShowNewPassword(false);

    // Set feedback settings if available
    if (eventFeedbackSettings) {
      setFeedbackSettings(eventFeedbackSettings);
    }

    // Parse theme configuration
    if (event.color_theme) {
      try {
        if (event.color_theme.startsWith('{')) {
          const parsedTheme = JSON.parse(event.color_theme);
          setCurrentTheme(parsedTheme);
          // Try to find matching preset
          const matchingPreset = Object.entries(GALLERY_THEME_PRESETS).find(
            ([_, preset]) => JSON.stringify(preset.config) === JSON.stringify(parsedTheme)
          );
          setCurrentPresetName(matchingPreset ? matchingPreset[0] : 'custom');
        } else {
          // Legacy theme name
          const preset = GALLERY_THEME_PRESETS[event.color_theme];
          if (preset) {
            setCurrentTheme(preset.config);
            setCurrentPresetName(event.color_theme);
          }
        }
      } catch {
        setCurrentTheme(GALLERY_THEME_PRESETS.default.config);
        setCurrentPresetName('default');
      }
    } else {
      // No color_theme stored — the gallery renders with the site
      // branding theme as a fallback. Mirror that here so the picker
      // shows the same palette the admin sees on the gallery, rather
      // than the hardcoded Classic Grid preset that has nothing to do
      // with their branding (#550 follow-up). currentPresetName=custom
      // because the inherited config isn't a named preset; combined
      // with themeChanged=false below, saving without touching the
      // picker leaves color_theme NULL and preserves inheritance.
      const branding = publicSettings?.theme_config as ThemeConfig | undefined;
      setCurrentTheme(branding ?? GALLERY_THEME_PRESETS.default.config);
      setCurrentPresetName(branding ? 'custom' : 'default');
    }
    setThemeChanged(false);

    setIsEditing(true);
  };

  const handleSaveEdit = async () => {
    // Prepare color_theme - if we have a custom theme, serialize it
    let themeToSave = editForm.color_theme;
    if (currentTheme && currentPresetName === 'custom') {
      themeToSave = JSON.stringify(currentTheme);
    } else if (currentPresetName && currentPresetName !== 'custom') {
      // Use preset name for non-custom themes
      themeToSave = currentPresetName;
    }

    const externalPathToSave = editForm.external_path?.trim() || '';

    const currentRequirePassword = normalizeRequirePassword(event.require_password);
    const requirePasswordChanged = editForm.require_password !== currentRequirePassword;

    if (editForm.require_password) {
      if (requirePasswordChanged && !editForm.new_password) {
        toast.error(t('events.newPasswordRequired', 'Please set a password before enabling protection.'));
        return;
      }
      if (editForm.new_password) {
        if (editForm.new_password.length < 6) {
          toast.error(t('validation.passwordMinLength'));
          return;
        }
        if (editForm.new_password !== editForm.confirm_new_password) {
          toast.error(t('validation.passwordsDoNotMatch'));
          return;
        }
      }
    }

    if (editForm.source_mode === 'reference' && !externalPathToSave) {
      toast.error(t('events.externalFolderRequired', 'Please select an external folder before saving.'));
      return;
    }

    // No expiration-required validation on edit (#426). The global
    // `event_require_expiration` setting only enforces a default at
    // create-time — once an event exists, an admin can clear the
    // expiration via this form. The matching backend gate was dropped
    // in adminEvents.js.

    // Clean up the data - remove undefined values
    const updateData: any = {
      expires_at: editForm.expires_at || null,
      allow_user_uploads: editForm.allow_user_uploads,
      require_password: editForm.require_password,
      css_template_id: editForm.css_template_id,
      // Download protection settings
      protection_level: editForm.protection_level,
      disable_right_click: editForm.disable_right_click,
      allow_downloads: editForm.allow_downloads,
      watermark_downloads: editForm.watermark_downloads,
      allow_presigned_download: editForm.allow_presigned_download,
      enable_devtools_protection: editForm.enable_devtools_protection,
      use_canvas_rendering: editForm.use_canvas_rendering,
      // Hero logo settings
      hero_logo_visible: editForm.hero_logo_visible,
      hero_logo_size: editForm.hero_logo_size,
      hero_logo_position: editForm.hero_logo_position,
      // Hero image anchor position (#162)
      hero_image_anchor: editForm.hero_image_anchor,
      // Photo cap
      photo_cap: editForm.photo_cap > 0 ? editForm.photo_cap : null,
      // Default photo sort
      default_photo_sort: editForm.default_photo_sort,
      // Header style settings (decoupled from layout, #158)
      header_style: currentTheme?.headerStyle || 'standard',
      hero_divider_style: currentTheme?.heroDividerStyle || 'wave',
      // Per-event promotional override (#440). Backend nulls
      // promo_markdown automatically when mode != 'custom'.
      promo_mode: editForm.promo_mode,
      promo_markdown: editForm.promo_mode === 'custom' ? editForm.promo_markdown : null,
      // Customer accounts (#354) — flat array of ids. Backend diffs
      // against existing assignments in one transaction.
      customer_account_ids: editForm.customer_accounts.map((c) => c.id),
    };

    // Only include fields that have defined values
    if (editForm.welcome_message !== undefined && editForm.welcome_message !== null) {
      updateData.welcome_message = editForm.welcome_message;
    }
    // Only persist color_theme when the admin actually interacted with
    // the picker. Writing the initial display state back to the row
    // silently overwrote NULL (= "inherit branding") with the picker's
    // default preset on any save (#550 follow-up).
    if (themeChanged && themeToSave) {
      updateData.color_theme = themeToSave;
    }
    if (editForm.upload_category_id !== undefined) {
      updateData.upload_category_id = editForm.upload_category_id;
    }
    if (editForm.hero_photo_id !== undefined) {
      updateData.hero_photo_id = editForm.hero_photo_id;
    }
    // Per-event hero-photo OG share opt-in (#474). Always send the
    // current state — the backend writes through formatBoolean either
    // way, so an explicit save can flip the value back to false.
    updateData.og_image_share_enabled = editForm.og_image_share_enabled;
    updateData.source_mode = editForm.source_mode;
    updateData.external_path = editForm.source_mode === 'reference'
      ? externalPathToSave
      : null;
    if (editForm.customer_name !== undefined && editForm.customer_name !== null) {
      updateData.customer_name = editForm.customer_name;
    }
    if (editForm.customer_email !== undefined && editForm.customer_email !== null && editForm.customer_email.trim()) {
      updateData.customer_email = editForm.customer_email;
    }
    if (editForm.customer_phone !== undefined) {
      // Send empty string as null so an admin can clear the field. Backend
      // strips this entirely if the global phone-field toggle is off.
      updateData.customer_phone = editForm.customer_phone.trim() || null;
    }

    if (editForm.new_password) {
      updateData.password = editForm.new_password;
    }

    // Remove any keys with undefined values
    Object.keys(updateData).forEach(key => {
      if (updateData[key] === undefined) {
        delete updateData[key];
      }
    });

    // Event update with validation

    // Update event details
    updateMutation.mutate(updateData);

    // Update feedback settings separately
    try {
      await feedbackService.updateEventFeedbackSettings(id!, feedbackSettings);
    } catch {
      // Error already handled by mutation
    }
  };

  return (
    <div>
      {/* Page Header + Draft Banner + Expiration Warning */}
      <EventDetailsHeader
        event={event}
        id={id}
        isEditing={isEditing}
        setIsEditing={setIsEditing}
        handleStartEdit={handleStartEdit}
        handleSaveEdit={handleSaveEdit}
        isSaving={updateMutation.isPending}
        feedbackSettings={feedbackSettings}
        setShowRenameDialog={setShowRenameDialog}
        setShowPublishDialog={setShowPublishDialog}
        isPublishing={publishMutation.isPending}
        onExtendExpiration={(days) => extendMutation.mutate(days)}
        daysUntilExpiration={daysUntilExpiration}
        isExpired={isExpired}
        isExpiring={isExpiring}
      />

      {/* Tabs */}
      <EventTabs
        event={event}
        eventFeedbackSettings={eventFeedbackSettings}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
      />

      {/* Tab Content */}
      {activeTab === 'overview' && (
        <OverviewTab
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
          refetchEvent={refetchEvent}
          setActiveTab={setActiveTab}
          setShowPasswordReset={setShowPasswordReset}
          setShowPublishDialog={setShowPublishDialog}
          setShowDuplicateDialog={setShowDuplicateDialog}
          onArchive={() => archiveMutation.mutate()}
          isArchiving={archiveMutation.isPending}
          isPublishing={publishMutation.isPending}
          isDuplicating={duplicateMutation.isPending}
          currentTheme={currentTheme}
          setCurrentTheme={setCurrentTheme}
          currentPresetName={currentPresetName}
          setCurrentPresetName={setCurrentPresetName}
          setThemeChanged={setThemeChanged}
          cssTemplates={cssTemplates}
        />
      )}

      {/* Photos Tab */}
      {activeTab === 'photos' && (
        <PhotosTab
          event={event}
          id={id}
          photos={photos}
          photosLoading={photosLoading}
          refetchPhotos={refetchPhotos}
          categories={categories}
          photoFilters={photoFilters}
          setPhotoFilters={setPhotoFilters}
          feedbackFilters={feedbackFilters}
          setFeedbackFilters={setFeedbackFilters}
          filterSummary={filterSummary}
          showMediaFilter={showMediaFilter}
        />
      )}

      {/* Categories Tab */}
      {activeTab === 'categories' && (
        <CategoriesTab id={id} />
      )}

      {/* Guests Tab (only visible when identity_mode === 'guest') */}
      {activeTab === 'guests' && eventFeedbackSettings?.identity_mode === 'guest' && (
        <AdminGuestsList eventId={parseInt(id!)} eventName={event.event_name} />
      )}

      {/* Password Reset Modal */}
      {showPasswordReset && (
        <PasswordResetModal
          eventName={event.event_name}
          eventDate={event.event_date}
          eventType={event.event_type}
          onConfirm={async (sendEmail, password) => {
            const result = await eventsService.resetPassword(event.id, sendEmail, password);
            return result;
          }}
          onClose={() => setShowPasswordReset(false)}
        />
      )}

      {/* Event Rename Dialog */}
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

      {/* Publish Gallery Dialog (#627) — prompts for the password so the
          gallery_created email carries the real plaintext, not the sentinel. */}
      {showPublishDialog && (
        <PublishGalleryDialog
          eventName={event.event_name}
          requirePassword={isGalleryPublic(event) ? false : true}
          customerEmail={event.customer_email}
          assignedCustomerCount={((event as { customer_accounts?: Array<{ id: number }> }).customer_accounts || []).length}
          isPublishing={publishMutation.isPending}
          onConfirm={(password) => publishMutation.mutate(password)}
          onClose={() => {
            if (!publishMutation.isPending) setShowPublishDialog(false);
          }}
        />
      )}

      {/* Duplicate Event Dialog (#626) — admin types a new event name/date
          (+ optional customer); backend clones the source gallery's config
          and we navigate to the new draft. */}
      {showDuplicateDialog && (
        <DuplicateEventDialog
          sourceEventName={event.event_name}
          isDuplicating={duplicateMutation.isPending}
          onConfirm={(data) => duplicateMutation.mutate(data)}
          onClose={() => {
            if (!duplicateMutation.isPending) setShowDuplicateDialog(false);
          }}
        />
      )}

    </div>
  );
};

EventDetailsPage.displayName = 'EventDetailsPage';
