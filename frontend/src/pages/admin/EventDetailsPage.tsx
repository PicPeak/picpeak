import React, { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  ExternalLink,
  Calendar,
  Download,
  Archive,
  Edit2,
  Save,
  X,
  AlertTriangle,
  Copy,
  CheckCircle,
  Upload,
  Image,
  Key,
  Mail,
  MessageSquare,
  Receipt,
  Lock,
  Eye,
  EyeOff,
  Type,
  Shield,
  Monitor,
  Droplets,
  MousePointer,
  Layout,
  Trash2,
  Send,
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  Loader2
} from 'lucide-react';
import { parseISO, differenceInDays, isValid } from 'date-fns';

// Helper to safely parse dates that might be strings, Date objects, or timestamps
const safeParseDate = (dateValue: unknown): Date | null => {
  if (!dateValue) {
    return null;
  }
  if (dateValue instanceof Date) {
    return dateValue;
  }
  if (typeof dateValue === 'number') {
    return new Date(dateValue);
  }
  if (typeof dateValue === 'string') {
    const parsed = parseISO(dateValue);
    return isValid(parsed) ? parsed : new Date(dateValue);
  }
  return null;
};
import { toast } from 'react-toastify';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';

import { Button, Input, Card, Loading, MarkdownContent, LocalizedDateInput } from '../../components/common';
import { EventCategoryManager, AdminPhotoGrid, AdminPhotoViewer, PhotoFilters, PasswordResetModal, PublishGalleryDialog, DuplicateEventDialog, ThemeCustomizerEnhanced, ThemeDisplay, HeroPhotoSelector, FocalPointPicker, PhotoUploadModal, FeedbackSettings, FeedbackModerationPanel, EventRenameDialog, PhotoFilterPanel, PhotoExportMenu, AdminGuestsList } from '../../components/admin';
import { CustomerAccountPicker } from '../../components/admin/CustomerAccountPicker';
import { EventReminderOverrideCard } from '../../components/admin/EventReminderOverrideCard';
import { SlideshowSettingsCard } from '../../components/admin/SlideshowSettingsCard';
import { ShortUrlsCard } from '../../components/admin/ShortUrlsCard';
import { useFeatureFlags } from '../../contexts/FeatureFlagsContext';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { eventsService } from '../../services/events.service';
import { usePublicSettings } from '../../hooks/usePublicSettings';
import { api } from '../../config/api';
import { buildResourceUrl, buildShareLinkUrl } from '../../utils/url';
import { isGalleryPublic, normalizeRequirePassword } from '../../utils/accessControl';
import { archiveService } from '../../services/archive.service';
import { externalMediaService, type ExternalEntry } from '../../services/externalMedia.service';
import { photosService, AdminPhoto, type PhotoFilters as PhotoFilterParams, type FeedbackFilters } from '../../services/photos.service';
import { feedbackService, FeedbackSettings as FeedbackSettingsType } from '../../services/feedback.service';
import { cssTemplatesService, type EnabledTemplate } from '../../services/cssTemplates.service';
import { ThemeConfig, GALLERY_THEME_PRESETS } from '../../types/theme.types';

const FolderTreeNode: React.FC<{
  path: string;
  name: string;
  depth: number;
  value: string;
  onChange: (p: string) => void;
  expandedPaths: Set<string>;
  toggleExpand: (p: string) => void;
}> = ({ path, name, depth, value, onChange, expandedPaths, toggleExpand }) => {
  const { t } = useTranslation();
  const isExpanded = expandedPaths.has(path);
  const isSelected = value === path;

  const { data, isLoading, isError } = useQuery({
    queryKey: ['external-folder-children', path],
    queryFn: () => externalMediaService.list(path),
    enabled: isExpanded,
    staleTime: 30_000
  });

  const dirs = (data?.entries || []).filter(e => e.type === 'dir');
  const showEmpty = isExpanded && !isLoading && !isError && dirs.length === 0;
  const indentStyle = { paddingLeft: depth * 16 + 4 };
  const childIndentStyle = { paddingLeft: (depth + 1) * 16 + 4 };
  const rowClass =
    'flex items-center gap-1 py-1 pr-1 rounded ' +
    (isSelected
      ? 'bg-accent-dark/15'
      : 'hover:bg-neutral-50 dark:hover:bg-neutral-700');

  return (
    <div>
      <div className={rowClass} style={indentStyle}>
        <button
          type="button"
          onClick={() => toggleExpand(path)}
          className="p-0.5 text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
          aria-label={isExpanded ? t('common.collapse', 'Collapse') : t('common.expand', 'Expand')}
        >
          {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
        <button
          type="button"
          onClick={() => onChange(path)}
          className={
            'flex items-center gap-1.5 flex-1 min-w-0 text-left text-sm ' +
            (isSelected
              ? 'text-accent-dark font-medium'
              : 'text-neutral-900 dark:text-neutral-100')
          }
        >
          {isExpanded ? (
            <FolderOpen className="w-4 h-4 flex-shrink-0 text-accent" />
          ) : (
            <Folder className="w-4 h-4 flex-shrink-0 text-neutral-500" />
          )}
          <span className="truncate">{name}</span>
        </button>
      </div>
      {isExpanded && (
        <div>
          {isLoading && (
            <div
              className="flex items-center gap-2 py-1 text-xs text-neutral-500 dark:text-neutral-400"
              style={childIndentStyle}
            >
              <Loader2 className="w-3 h-3 animate-spin" />
              <span>{t('common.loading', 'Loading...')}</span>
            </div>
          )}
          {isError && (
            <div
              className="py-1 text-xs text-red-600 dark:text-red-400"
              style={childIndentStyle}
            >
              {t('errors.somethingWentWrong', 'Something went wrong')}
            </div>
          )}
          {showEmpty && (
            <div
              className="py-1 text-xs italic text-neutral-500 dark:text-neutral-400"
              style={childIndentStyle}
            >
              {t('events.externalFolderEmpty', 'No subfolders')}
            </div>
          )}
          {dirs.map(d => {
            const childPath = path ? `${path}/${d.name}` : d.name;
            return (
              <FolderTreeNode
                key={childPath}
                path={childPath}
                name={d.name}
                depth={depth + 1}
                value={value}
                onChange={onChange}
                expandedPaths={expandedPaths}
                toggleExpand={toggleExpand}
              />
            );
          })}
        </div>
      )}
    </div>
  );
};

const ExternalFolderPicker: React.FC<{ value: string; onChange: (p: string) => void }> = ({ value, onChange }) => {
  const { t } = useTranslation();

  // Seed expanded paths so the current selection (and the synthetic root) is visible on mount.
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => {
    const set = new Set<string>(['']);
    if (value) {
      const parts = value.split('/').filter(Boolean);
      let acc = '';
      for (const seg of parts) {
        acc = acc ? `${acc}/${seg}` : seg;
        set.add(acc);
      }
    }
    return set;
  });

  const toggleExpand = (p: string) => {
    setExpandedPaths(prev => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  };

  return (
    <div className="mt-2 border border-neutral-200 dark:border-neutral-700 rounded-lg p-2">
      <div className="flex items-center justify-between gap-2 mb-2 px-1">
        <div className="text-xs text-neutral-600 dark:text-neutral-400 truncate">
          {t('common.selected', 'Selected')}: /external-media/{value}
        </div>
        {value && (
          <button
            type="button"
            className="text-xs underline text-neutral-700 dark:text-neutral-300 hover:text-neutral-900 dark:hover:text-neutral-100 flex-shrink-0"
            onClick={() => onChange('')}
          >
            {t('events.clearSelection', 'Clear')}
          </button>
        )}
      </div>
      <div className="max-h-80 overflow-auto [color-scheme:light] dark:[color-scheme:dark]">
        <FolderTreeNode
          path=""
          name="/external-media"
          depth={0}
          value={value}
          onChange={onChange}
          expandedPaths={expandedPaths}
          toggleExpand={toggleExpand}
        />
      </div>
    </div>
  );
};

export const EventDetailsPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const { format, formatDateTime: fmtDateTime } = useLocalizedDate();
  const { flags } = useFeatureFlags();

  // Validate ID parameter
  React.useEffect(() => {
    if (!id || isNaN(parseInt(id))) {
      navigate('/admin/events');
    }
  }, [id, navigate]);
  
  type EditFormState = {
    welcome_message: string;
    color_theme: string;
    css_template_id: number | null;
    expires_at: string;
    allow_user_uploads: boolean;
    upload_category_id: number | null;
    hero_photo_id: number | null;
    customer_name: string;
    customer_email: string;
    customer_phone: string;
    source_mode: 'managed' | 'reference';
    external_path: string;
    require_password: boolean;
    new_password: string;
    confirm_new_password: string;
    // Download protection settings
    protection_level: 'basic' | 'standard' | 'enhanced' | 'maximum';
    disable_right_click: boolean;
    allow_downloads: boolean;
    watermark_downloads: boolean;
    allow_presigned_download: boolean;
    enable_devtools_protection: boolean;
    use_canvas_rendering: boolean;
    // Hero logo settings
    hero_logo_visible: boolean;
    hero_logo_size: 'small' | 'medium' | 'large' | 'xlarge';
    hero_logo_position: 'top' | 'center' | 'bottom';
    // Hero image anchor position (#162) – keyword or "X% Y%" focal point
    hero_image_anchor: string;
    // Photo cap
    photo_cap: number;
    // Default photo sort
    default_photo_sort: string;
    // Per-event promotional override (#440). Three-way mode:
    //   inherit → use the global branding_promo_markdown
    //   custom  → render this event's promo_markdown
    //   off     → no promo for this event regardless of global
    promo_mode: 'inherit' | 'custom' | 'off';
    promo_markdown: string;
    // Customer accounts assigned to this event (#354). Hydrated from
    // the GET /admin/events/:id response and sent back as a flat id
    // array on save.
    customer_accounts: Array<{ id: number; email: string; displayName: string | null }>;
    // Per-event opt-in for hero photo as social-share preview (#474).
    og_image_share_enabled: boolean;
  };

  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState<EditFormState>({
    welcome_message: '',
    color_theme: '',
    css_template_id: null,
    expires_at: '',
    allow_user_uploads: false,
    upload_category_id: null,
    hero_photo_id: null,
    customer_name: '',
    customer_email: '',
    customer_phone: '',
    source_mode: 'managed',
    external_path: '',
    require_password: true,
    new_password: '',
    confirm_new_password: '',
    // Download protection settings
    protection_level: 'standard',
    disable_right_click: true,
    allow_downloads: true,
    watermark_downloads: false,
    allow_presigned_download: false,
    enable_devtools_protection: true,
    use_canvas_rendering: false,
    // Hero logo settings
    hero_logo_visible: true,
    hero_logo_size: 'medium',
    hero_logo_position: 'top',
    // Hero image anchor position (#162)
    hero_image_anchor: 'center',
    // Photo cap
    photo_cap: 0,
    // Default photo sort
    default_photo_sort: 'upload_date_desc',
    // Per-event promotional override (#440)
    promo_mode: 'inherit',
    promo_markdown: '',
    // Customer accounts (#354) — hydrated from event response.
    customer_accounts: [],
    // Per-event social-share opt-in (#474). Default false everywhere
    // so a freshly opened editor never displays "on" against the saved
    // (off) state.
    og_image_share_enabled: false,
  });
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
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedClientLink, setCopiedClientLink] = useState(false);
  const [clientPin, setClientPin] = useState('');
  const [showPhotoUpload, setShowPhotoUpload] = useState(false);
  const [showExternalImport, setShowExternalImport] = useState(false);
  const [activeTab, setActiveTab] = useState<'overview' | 'photos' | 'categories' | 'guests'>('overview');
  const [externalPath, setExternalPath] = useState<string>('');
  const [importing, setImporting] = useState<boolean>(false);
  const [selectedPhoto, setSelectedPhoto] = useState<{ photo: AdminPhoto; index: number } | null>(null);
  const [showPasswordReset, setShowPasswordReset] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [showPublishDialog, setShowPublishDialog] = useState(false);
  const [showDuplicateDialog, setShowDuplicateDialog] = useState(false);
  const [logoUploading, setLogoUploading] = useState(false);
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
  const [selectedPhotoIds, setSelectedPhotoIds] = useState<number[]>([]);

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
      // Load hero logo settings from event
      hero_logo_visible: event.hero_logo_visible ?? true,
      hero_logo_size: event.hero_logo_size || 'medium',
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

  const handleEventLogoUpload = async (file: File) => {
    if (!id) return;
    setLogoUploading(true);
    try {
      const formData = new FormData();
      formData.append('logo', file);
      await api.post(`/admin/events/${id}/logo`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      toast.success(t('events.eventLogoUploaded', 'Event logo uploaded successfully'));
      queryClient.invalidateQueries({ queryKey: ['event', id] });
    } catch (error: any) {
      toast.error(error?.response?.data?.error || t('events.eventLogoUploadFailed', 'Failed to upload event logo'));
    } finally {
      setLogoUploading(false);
    }
  };

  const handleEventLogoRemove = async () => {
    if (!id) return;
    setLogoUploading(true);
    try {
      await api.delete(`/admin/events/${id}/logo`);
      toast.success(t('events.eventLogoRemoved', 'Event logo removed successfully'));
      queryClient.invalidateQueries({ queryKey: ['event', id] });
    } catch (error: any) {
      toast.error(error?.response?.data?.error || t('events.eventLogoRemoveFailed', 'Failed to remove event logo'));
    } finally {
      setLogoUploading(false);
    }
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

  const handleCopyLink = async () => {
    try {
      // Check if share_link exists
      if (!event.share_link) {
        toast.error(t('errors.noShareLink', 'No share link available'));
        return;
      }

      const shareUrl = buildShareLinkUrl(event.share_link);

      // Try modern clipboard API first
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(shareUrl);
      } else {
        // Fallback for non-HTTPS contexts or older browsers
        const textArea = document.createElement('textarea');
        textArea.value = shareUrl;
        textArea.style.position = 'fixed';
        textArea.style.left = '-999999px';
        textArea.style.top = '-999999px';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        const successful = document.execCommand('copy');
        document.body.removeChild(textArea);
        if (!successful) {
          throw new Error('Copy failed');
        }
      }
      
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
      toast.success(t('toast.linkCopied'));
    } catch (err) {
      console.error('Copy failed:', err);
      toast.error(t('errors.copyFailed', 'Failed to copy link. Please copy manually.'));
    }
  };


  return (
    <div>
      {/* Page Header */}
      <div className="mb-6">
        <Button
          variant="outline"
          size="sm"
          leftIcon={<ArrowLeft className="w-4 h-4" />}
          onClick={() => navigate('/admin/events')}
          className="mb-4"
        >
          {t('events.backToEvents')}
        </Button>
        
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">{event.event_name}</h1>
            <div className="flex items-center gap-4 mt-2 text-sm text-neutral-600 dark:text-neutral-400">
              {event.event_date && (
                <span className="flex items-center">
                  <Calendar className="w-4 h-4 mr-1" />
                  {format(safeParseDate(event.event_date)!, 'PPP')}
                </span>
              )}
              <span className="capitalize">{event.event_type}</span>
              <span
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                  isGalleryPublic(event.require_password)
                    ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300'
                    : 'bg-neutral-100 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300'
                }`}
              >
                {isGalleryPublic(event.require_password) ? t('events.publicAccess', 'Public access') : t('events.passwordProtected', 'Password protected')}
              </span>
              {event.is_draft ? (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-300">
                  {t('events.draft')}
                </span>
              ) : null}
              {event.is_archived ? (
                <span className="text-neutral-500 dark:text-neutral-400 flex items-center">
                  <Archive className="w-4 h-4 mr-1" />
                  {t('events.archived')}
                </span>
              ) : null}
            </div>
          </div>
          
          <div className="flex gap-2 items-center">
            {!event.is_archived && (
              <>
                {isEditing ? (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      leftIcon={<X className="w-4 h-4" />}
                      onClick={() => setIsEditing(false)}
                    >
                      {t('common.cancel')}
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      leftIcon={<Save className="w-4 h-4" />}
                      onClick={handleSaveEdit}
                      isLoading={updateMutation.isPending}
                    >
                      {t('events.saveChanges')}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      leftIcon={<Edit2 className="w-4 h-4" />}
                      onClick={handleStartEdit}
                    >
                      {t('common.edit')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      leftIcon={<Type className="w-4 h-4" />}
                      onClick={() => setShowRenameDialog(true)}
                    >
                      {t('events.rename.button', 'Rename')}
                    </Button>
                    {feedbackSettings?.feedback_enabled && (
                      <Button
                        variant="outline"
                        size="sm"
                        leftIcon={<MessageSquare className="w-4 h-4" />}
                        onClick={() => navigate(`/admin/events/${id}/feedback`)}
                      >
                        {t('feedback.manage', 'Manage Feedback')}
                      </Button>
                    )}
                    {/* Create a draft invoice for this event — pre-fills the
                        bill editor with the event snapshot + (when exactly
                        one is linked) the customer. Gated on the bills flag. */}
                    {flags.bills && (
                      <Button
                        variant="outline"
                        size="sm"
                        leftIcon={<Receipt className="w-4 h-4" />}
                        onClick={() => {
                          const accts = ((event as { customer_accounts?: Array<{ id: number }> }).customer_accounts) || [];
                          const params = new URLSearchParams({ eventId: String(event.id) });
                          if (event.event_name) params.set('eventName', event.event_name);
                          if (event.event_date) params.set('eventDate', String(event.event_date).slice(0, 10));
                          if (accts.length === 1) params.set('customerAccountId', String(accts[0].id));
                          navigate(`/admin/clients/bills/new?${params.toString()}`);
                        }}
                      >
                        {t('events.createInvoice', 'Create invoice')}
                      </Button>
                    )}
                  </>
                )}
              </>
            )}
            {event.share_link && !isEditing && (
              <a
                href={event.is_draft
                  ? `${buildShareLinkUrl(event.share_link)}${buildShareLinkUrl(event.share_link).includes('?') ? '&' : '?'}preview=${eventsService.getPreviewToken() || ''}`
                  : buildShareLinkUrl(event.share_link)
                }
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-accent hover:opacity-80 border border-accent-dark rounded-lg hover:bg-accent-dark/15 transition-colors"
              >
                <ExternalLink className="w-4 h-4" />
                {t('events.viewGallery')}
              </a>
            )}
          </div>
        </div>
      </div>

      {/* Draft Banner */}
      {event.is_draft && !event.is_archived && (
        <Card className="p-4 mb-6 border-2 border-yellow-500 bg-yellow-50 dark:bg-yellow-900/20">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 flex-shrink-0 text-yellow-600 dark:text-yellow-400" />
            <div className="flex-1">
              <p className="font-medium text-yellow-900 dark:text-yellow-200">
                {t('events.draft')}
              </p>
              <p className="text-sm mt-1 text-yellow-700 dark:text-yellow-300">
                {t('events.draftBanner')}
              </p>
            </div>
            <Button
              variant="primary"
              size="sm"
              leftIcon={<Send className="w-4 h-4" />}
              onClick={() => setShowPublishDialog(true)}
              isLoading={publishMutation.isPending}
            >
              {t('events.publishAndNotify')}
            </Button>
          </div>
        </Card>
      )}

      {/* Expiration Warning */}
      {!event.is_archived && (isExpired || isExpiring) && (
        <Card className={`p-4 mb-6 border-2 ${isExpired ? 'border-red-500 bg-red-50' : 'border-orange-500 bg-orange-50'}`}>
          <div className="flex items-start gap-3">
            <AlertTriangle className={`w-5 h-5 flex-shrink-0 ${isExpired ? 'text-red-600' : 'text-orange-600'}`} />
            <div className="flex-1">
              <p className={`font-medium ${isExpired ? 'text-red-900' : 'text-orange-900'}`}>
                {isExpired 
                  ? t('events.eventExpiredMessage')
                  : t('events.eventExpiresIn', { days: daysUntilExpiration })
                }
              </p>
              <p className={`text-sm mt-1 ${isExpired ? 'text-red-700' : 'text-orange-700'}`}>
                {isExpired
                  ? t('events.guestsCannotAccessGallery')
                  : t('events.warningEmailsHaveBeenSent')}
              </p>
            </div>
            {!isExpired && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (confirm(t('events.extendExpiration', { days: 7 }) + '?')) {
                    extendMutation.mutate(7);
                  }
                }}
              >
                {t('events.extendSevenDays')}
              </Button>
            )}
          </div>
        </Card>
      )}

      {/* Tabs */}
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

      {/* Tab Content */}
      {activeTab === 'overview' && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Left Column - Main Details */}
        <div className="space-y-6">
          {/* Event Information */}
          <Card padding="md">
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">{t('events.eventInformation')}</h2>
            
            {isEditing ? (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                    {t('events.welcomeMessageLabel')}
                  </label>
                  <textarea
                    value={editForm.welcome_message}
                    onChange={(e) => setEditForm(prev => ({ ...prev, welcome_message: e.target.value }))}
                    className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-accent-dark"
                    rows={3}
                    placeholder={t('events.welcomeMessage')}
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                    {t('events.hostName')}
                  </label>
                  <Input
                    type="text"
                    value={editForm.customer_name}
                    onChange={(e) => setEditForm(prev => ({ ...prev, customer_name: e.target.value }))}
                    placeholder={t('events.hostNamePlaceholder')}
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                    {t('events.hostEmail')}
                  </label>
                  <Input
                    type="email"
                    value={editForm.customer_email}
                    onChange={(e) => setEditForm(prev => ({ ...prev, customer_email: e.target.value }))}
                    placeholder={t('events.hostEmailPlaceholder')}
                  />
                </div>

                {phoneFieldEnabled && (
                  <div>
                    <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                      {t('events.customerPhone', 'Customer Phone')} ({t('common.optional')})
                    </label>
                    <Input
                      type="tel"
                      value={editForm.customer_phone}
                      onChange={(e) => setEditForm(prev => ({ ...prev, customer_phone: e.target.value }))}
                      placeholder={t('events.customerPhonePlaceholder', '+1 555 555 1234')}
                    />
                  </div>
                )}

                {/* Customer accounts (#354). Picker self-hides when the
                    customerPortal feature flag is off. */}
                <CustomerAccountPicker
                  value={editForm.customer_accounts}
                  onChange={(next) => setEditForm((prev) => ({ ...prev, customer_accounts: next }))}
                />

                <div>
                  <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                    {t('events.expirationDate')}
                  </label>
                  <LocalizedDateInput
                    value={editForm.expires_at}
                    onChange={(iso) => setEditForm(prev => ({ ...prev, expires_at: iso }))}
                    min={format(new Date(), 'yyyy-MM-dd')}
                  />
                </div>
                
                {/* Hero Photo Selection */}
                <HeroPhotoSelector
                  photos={photos || []}
                  currentHeroPhotoId={editForm.hero_photo_id}
                  onSelect={(photoId) => setEditForm(prev => ({ ...prev, hero_photo_id: photoId }))}
                  isEditing={isEditing}
                />

                {/* Per-event social-share opt-in (#474). Toggle is
                    disabled when no hero photo is picked — there's
                    nothing to surface as the cover. The help text
                    deliberately spells out the public-by-design
                    consequence so an admin doesn't flip this on for
                    a sensitive gallery without realising what they're
                    sharing with link-preview crawlers. */}
                <div className="ml-6 mt-3">
                  <label className={`flex items-start gap-2 cursor-pointer ${editForm.hero_photo_id ? '' : 'opacity-60 cursor-not-allowed'}`}>
                    <input
                      type="checkbox"
                      className="mt-0.5 rounded border-neutral-300 dark:border-neutral-600 text-accent focus:ring-primary-500"
                      checked={editForm.og_image_share_enabled === true}
                      disabled={!editForm.hero_photo_id}
                      onChange={(e) => setEditForm(prev => ({ ...prev, og_image_share_enabled: e.target.checked }))}
                    />
                    <span className="text-sm">
                      <span className="font-medium text-neutral-900 dark:text-neutral-100">
                        {t('events.ogShare.title', 'Use hero photo as social-share preview')}
                      </span>
                      <span className="block text-xs text-neutral-600 dark:text-neutral-400 mt-0.5">
                        {editForm.hero_photo_id
                          ? t('events.ogShare.help', 'When this gallery URL is shared on WhatsApp, Facebook, Slack, etc., the link preview will show the hero photo above. The thumbnail is fetched unauthenticated by link-preview crawlers — anyone with the URL effectively makes this image public. Off by default; pick a hero you are comfortable surfacing publicly before enabling.')
                          : t('events.ogShare.heroRequired', 'Pick a hero photo above first — this option uses it as the WhatsApp / Facebook / Slack preview image.')}
                      </span>
                    </span>
                  </label>
                </div>

                {/* Hero Image Focal Point Picker (#162) */}
                {editForm.hero_photo_id && (() => {
                  const heroPhoto = (photos || []).find((p) => p.id === editForm.hero_photo_id);
                  const heroImageUrl = heroPhoto?.thumbnail_url || heroPhoto?.url;
                  if (!heroImageUrl) return null;
                  return (
                    <div className="ml-6 mt-2">
                      <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                        {t('events.heroImageAnchor', 'Hero Image Crop Position')}
                      </label>
                      <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-2">
                        {t('events.heroImageAnchorDescription', 'Click on the image to set the focal point for cropping.')}
                      </p>
                      <FocalPointPicker
                        imageUrl={heroImageUrl}
                        currentValue={editForm.hero_image_anchor}
                        onChange={(value) => setEditForm(prev => ({ ...prev, hero_image_anchor: value }))}
                        slug={event.slug}
                      />
                    </div>
                  );
                })()}

                <div>
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-1 w-4 h-4 text-accent border-neutral-300 dark:border-neutral-600 rounded focus:ring-primary-500"
                      checked={editForm.require_password}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setEditForm(prev => ({
                          ...prev,
                          require_password: checked,
                          new_password: checked ? prev.new_password : '',
                          confirm_new_password: checked ? prev.confirm_new_password : '',
                        }));
                        if (!checked) {
                          setShowNewPassword(false);
                        }
                      }}
                    />
                    <div>
                      <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">{t('events.requirePasswordToggle')}</span>
                      <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                        {t('events.requirePasswordToggleHelp', 'Disable this if you want to share the gallery without a password. Anyone with the link will be able to view the photos.')}
                      </p>
                    </div>
                  </label>

                  {!editForm.require_password && (
                    <div className="mt-2 rounded-md border border-orange-200 dark:border-orange-800 bg-orange-50 dark:bg-orange-900/30 p-3 text-xs text-orange-800 dark:text-orange-300">
                      {t('events.publicGalleryWarning', 'Public galleries are accessible to anyone with the link. Consider enabling download watermarks and monitoring activity.')} 
                    </div>
                  )}
                </div>

                {editForm.require_password && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                        {t('events.newPasswordLabel', 'New gallery password')}
                      </label>
                      <div className="relative">
                        <Input
                          type={showNewPassword ? 'text' : 'password'}
                          value={editForm.new_password}
                          onChange={(e) => setEditForm(prev => ({ ...prev, new_password: e.target.value }))}
                          placeholder={t('events.enterPassword')}
                          leftIcon={<Lock className="w-5 h-5 text-neutral-400" />}
                          className="pr-10"
                        />
                        <button
                          type="button"
                          onClick={() => setShowNewPassword(!showNewPassword)}
                          className="absolute inset-y-0 right-0 pr-3 flex items-center"
                        >
                          {showNewPassword ? (
                            <EyeOff className="w-5 h-5 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300" />
                          ) : (
                            <Eye className="w-5 h-5 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300" />
                          )}
                        </button>
                      </div>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                        {t('events.confirmPassword')}
                      </label>
                      <Input
                        type={showNewPassword ? 'text' : 'password'}
                        value={editForm.confirm_new_password}
                        onChange={(e) => setEditForm(prev => ({ ...prev, confirm_new_password: e.target.value }))}
                        placeholder={t('events.confirmPasswordPlaceholder')}
                        leftIcon={<Lock className="w-5 h-5 text-neutral-400" />}
                      />
                    </div>
                  </div>
                )}

                <div>
                  <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                    {t('events.sourceMode', 'Source Mode')}
                  </label>
                  <select
                    value={editForm.source_mode}
                    onChange={(e) => {
                      const mode = e.target.value as 'managed' | 'reference';
                      setEditForm(prev => ({
                        ...prev,
                        source_mode: mode,
                        external_path: mode === 'reference'
                          ? (prev.external_path || event.external_path || '')
                          : ''
                      }));
                    }}
                    className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-accent-dark"
                  >
                    <option value="managed">{t('events.sourceModeManaged', 'Managed (upload to PicPeak)')}</option>
                    <option value="reference">{t('events.sourceModeReference', 'Reference external folder')}</option>
                  </select>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                    {t('events.sourceModeHelp', 'Use managed mode for direct uploads or reference an external folder that is mounted at /external-media in Docker.')}
                  </p>
                </div>

                {editForm.source_mode === 'reference' && (
                  <div className="mt-3">
                    <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                      {t('events.externalFolder', 'External Folder')}
                    </label>
                    <ExternalFolderPicker
                      value={editForm.external_path || ''}
                      onChange={(folder) => setEditForm(prev => ({ ...prev, external_path: folder }))}
                    />
                    <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                      {t('events.externalFolderHint', 'These folders come from the /external-media mount inside the container. Ensure it is accessible to the backend process.')}
                    </p>
                  </div>
                )}
                
                {/* Photo Cap */}
                <div>
                  <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                    {t('events.photoCap', 'Photo Limit')}
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      value={editForm.photo_cap}
                      onChange={(e) => setEditForm(prev => ({ ...prev, photo_cap: parseInt(e.target.value) || 0 }))}
                      min={0}
                      className="w-24 px-3 py-2 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-accent-dark"
                    />
                    <span className="text-xs text-neutral-500 dark:text-neutral-400">
                      {t('events.photoCapHelp', 'Maximum number of photos allowed. 0 = unlimited')}
                    </span>
                  </div>
                </div>

                {/* Default Photo Sort */}
                <div>
                  <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                    {t('photoSort.defaultSort', 'Default Photo Sort')}
                  </label>
                  <select
                    value={editForm.default_photo_sort}
                    onChange={(e) => setEditForm(prev => ({ ...prev, default_photo_sort: e.target.value }))}
                    className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-accent-dark"
                  >
                    <option value="upload_date_desc">{t('photoSort.uploadDateNewest', 'Upload Date (Newest First)')}</option>
                    <option value="upload_date_asc">{t('photoSort.uploadDateOldest', 'Upload Date (Oldest First)')}</option>
                    <option value="capture_date_desc">{t('photoSort.captureDateNewest', 'Date Taken (Newest First)')}</option>
                    <option value="capture_date_asc">{t('photoSort.captureDateOldest', 'Date Taken (Oldest First)')}</option>
                    <option value="filename_asc">{t('photoSort.filenameAZ', 'Filename (A-Z)')}</option>
                    <option value="filename_desc">{t('photoSort.filenameZA', 'Filename (Z-A)')}</option>
                  </select>
                </div>

                <div>
                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      checked={editForm.allow_user_uploads}
                      onChange={(e) => setEditForm(prev => ({ ...prev, allow_user_uploads: e.target.checked }))}
                      className="w-4 h-4 text-accent border-neutral-300 dark:border-neutral-600 rounded focus:ring-primary-500"
                    />
                    <span className="ml-2 text-sm text-neutral-700 dark:text-neutral-300">{t('events.allowUserUploads')}</span>
                  </label>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1 ml-6">
                    {t('events.allowUserUploadsHelp')}
                  </p>
                </div>
                
                {editForm.allow_user_uploads && (
                  <div>
                    <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                      {t('events.uploadCategory')}
                    </label>
                    <select
                      value={editForm.upload_category_id || ''}
                      onChange={(e) => setEditForm(prev => ({
                        ...prev,
                        upload_category_id: e.target.value ? parseInt(e.target.value) : null
                      }))}
                      className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-accent-dark"
                    >
                      <option value="">{t('events.selectCategory')}</option>
                      {categories?.map(category => (
                        <option key={category.id} value={category.id}>
                          {category.name}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                      {t('events.uploadCategoryHelp')}
                    </p>
                  </div>
                )}
                
                {/* Feedback Settings */}
                <div className="mt-4 pt-4 border-t border-neutral-200 dark:border-neutral-700">
                  <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-3">{t('feedback.settings.title', 'Guest Feedback Settings')}</h3>
                  <FeedbackSettings
                    settings={feedbackSettings}
                    onChange={setFeedbackSettings}
                  />
                </div>

                {/* Promotional Banner Override (#440) — three-way: inherit / custom / off */}
                <div className="mt-4 pt-4 border-t border-neutral-200 dark:border-neutral-700">
                  <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-3">
                    {t('events.promoBanner.title', 'Promotional Banner')}
                  </h3>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-3">
                    {t('events.promoBanner.help', 'Choose how this gallery handles the promotional banner. "Inherit" uses your global default; "Custom" overrides it for this event; "Off" hides it entirely.')}
                  </p>
                  <div className="space-y-2">
                    {(['inherit', 'custom', 'off'] as const).map((mode) => (
                      <label key={mode} className="flex items-center">
                        <input
                          type="radio"
                          name="promo_mode"
                          value={mode}
                          checked={editForm.promo_mode === mode}
                          onChange={() => setEditForm(prev => ({ ...prev, promo_mode: mode }))}
                          className="w-4 h-4 text-accent border-neutral-300 dark:border-neutral-600 focus:ring-primary-500"
                        />
                        <span className="ml-2 text-sm text-neutral-700 dark:text-neutral-300">
                          {t(`events.promoBanner.mode_${mode}`, mode === 'inherit' ? 'Inherit global default' : mode === 'custom' ? 'Custom override for this event' : 'Off (hide for this event)')}
                        </span>
                      </label>
                    ))}
                  </div>
                  {editForm.promo_mode === 'custom' && (
                    <div className="mt-3 space-y-2">
                      <textarea
                        value={editForm.promo_markdown}
                        onChange={(e) => setEditForm(prev => ({ ...prev, promo_markdown: e.target.value }))}
                        rows={5}
                        placeholder={t('events.promoBanner.placeholder', 'Markdown content (e.g. **Special offer:** [book your next session](https://example.com))')}
                        className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-accent-dark font-mono text-sm"
                      />
                      {editForm.promo_markdown.trim() && (
                        <div className="border border-neutral-200 dark:border-neutral-700 rounded-lg p-3 bg-neutral-50 dark:bg-neutral-900">
                          <p className="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400 mb-2">
                            {t('events.promoBanner.preview', 'Preview')}
                          </p>
                          <MarkdownContent source={editForm.promo_markdown} className="text-sm text-neutral-800 dark:text-neutral-200 prose-sm prose-a:text-primary-600 dark:prose-a:text-primary-400" />
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Download Protection Settings */}
                <div className="mt-4 pt-4 border-t border-neutral-200 dark:border-neutral-700">
                  <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-3 flex items-center gap-2">
                    <Shield className="w-4 h-4 text-accent" />
                    {t('events.downloadProtection', 'Download Protection')}
                  </h3>

                  <div className="space-y-3">
                    <label className="flex items-center">
                      <input
                        type="checkbox"
                        checked={editForm.allow_downloads}
                        onChange={(e) => setEditForm(prev => ({ ...prev, allow_downloads: e.target.checked }))}
                        className="w-4 h-4 text-accent border-neutral-300 dark:border-neutral-600 rounded focus:ring-primary-500"
                      />
                      <Download className="w-4 h-4 ml-2 mr-1 text-neutral-500 dark:text-neutral-400" />
                      <span className="text-sm text-neutral-700 dark:text-neutral-300">{t('events.allowDownloads', 'Allow photo downloads')}</span>
                    </label>

                    <label className="flex items-center">
                      <input
                        type="checkbox"
                        checked={editForm.disable_right_click}
                        onChange={(e) => setEditForm(prev => ({ ...prev, disable_right_click: e.target.checked }))}
                        className="w-4 h-4 text-accent border-neutral-300 dark:border-neutral-600 rounded focus:ring-primary-500"
                      />
                      <MousePointer className="w-4 h-4 ml-2 mr-1 text-neutral-500 dark:text-neutral-400" />
                      <span className="text-sm text-neutral-700 dark:text-neutral-300">{t('events.disableRightClick', 'Block right-click menu')}</span>
                    </label>

                    <label className="flex items-center">
                      <input
                        type="checkbox"
                        checked={editForm.watermark_downloads}
                        onChange={(e) => setEditForm(prev => ({
                          ...prev,
                          watermark_downloads: e.target.checked,
                          // Watermarking and presigned URLs are mutually
                          // exclusive — presigned URLs serve raw bytes from
                          // S3 without going through the watermark pipeline.
                          allow_presigned_download: e.target.checked ? false : prev.allow_presigned_download,
                        }))}
                        className="w-4 h-4 text-accent border-neutral-300 dark:border-neutral-600 rounded focus:ring-primary-500"
                      />
                      <Droplets className="w-4 h-4 ml-2 mr-1 text-neutral-500 dark:text-neutral-400" />
                      <span className="text-sm text-neutral-700 dark:text-neutral-300">{t('events.watermarkDownloads', 'Add watermark to downloads')}</span>
                    </label>

                    <label
                      className={`flex items-center ${editForm.watermark_downloads ? 'opacity-50 cursor-not-allowed' : ''}`}
                      title={editForm.watermark_downloads
                        ? 'Disabled while watermarks are on — presigned URLs bypass the watermark pipeline.'
                        : 'When the backend uses STORAGE_BACKEND=s3, "Download All" returns a 5-minute presigned S3 URL instead of streaming through the backend. Saves bandwidth on huge galleries; bypasses watermarking.'
                      }
                    >
                      <input
                        type="checkbox"
                        checked={!!editForm.allow_presigned_download}
                        disabled={editForm.watermark_downloads}
                        onChange={(e) => setEditForm(prev => ({ ...prev, allow_presigned_download: e.target.checked }))}
                        className="w-4 h-4 text-accent border-neutral-300 dark:border-neutral-600 rounded focus:ring-primary-500"
                      />
                      <Download className="w-4 h-4 ml-2 mr-1 text-neutral-500 dark:text-neutral-400" />
                      <span className="text-sm text-neutral-700 dark:text-neutral-300">
                        {t('events.allowPresignedDownload', 'Allow direct S3 download (no watermark, S3 mode only)')}
                      </span>
                    </label>

                    <label className="flex items-center">
                      <input
                        type="checkbox"
                        checked={editForm.enable_devtools_protection}
                        onChange={(e) => setEditForm(prev => ({ ...prev, enable_devtools_protection: e.target.checked }))}
                        className="w-4 h-4 text-accent border-neutral-300 dark:border-neutral-600 rounded focus:ring-primary-500"
                      />
                      <Monitor className="w-4 h-4 ml-2 mr-1 text-neutral-500 dark:text-neutral-400" />
                      <span className="text-sm text-neutral-700 dark:text-neutral-300">{t('events.enableDevtoolsProtection', 'Detect developer tools')}</span>
                    </label>

                    <label className="flex items-center">
                      <input
                        type="checkbox"
                        checked={editForm.use_canvas_rendering}
                        onChange={(e) => setEditForm(prev => ({ ...prev, use_canvas_rendering: e.target.checked }))}
                        className="w-4 h-4 text-accent border-neutral-300 dark:border-neutral-600 rounded focus:ring-primary-500"
                      />
                      <Image className="w-4 h-4 ml-2 mr-1 text-neutral-500 dark:text-neutral-400" />
                      <span className="text-sm text-neutral-700 dark:text-neutral-300">{t('events.useCanvasRendering', 'Canvas rendering (advanced protection)')}</span>
                    </label>

                    <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-2">
                      {t('events.protectionInfo', 'Protection features help prevent unauthorized downloads but cannot block all methods.')}
                    </p>
                  </div>
                </div>

                {/* Hero Logo Settings */}
                <div className="mt-4 pt-4 border-t border-neutral-200 dark:border-neutral-700">
                  <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-3 flex items-center gap-2">
                    <Layout className="w-4 h-4 text-accent" />
                    {t('events.heroLogoSettings', 'Hero Logo Settings')}
                  </h3>

                  <div className="space-y-3">
                    <label className="flex items-center">
                      <input
                        type="checkbox"
                        checked={editForm.hero_logo_visible}
                        onChange={(e) => setEditForm(prev => ({ ...prev, hero_logo_visible: e.target.checked }))}
                        className="w-4 h-4 text-accent border-neutral-300 dark:border-neutral-600 rounded focus:ring-primary-500"
                      />
                      <Image className="w-4 h-4 ml-2 mr-1 text-neutral-500 dark:text-neutral-400" />
                      <span className="text-sm text-neutral-700 dark:text-neutral-300">{t('events.heroLogoVisible', 'Display logo in hero section')}</span>
                    </label>

                    {editForm.hero_logo_visible && (
                      <>
                        <div className="ml-6">
                          <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                            {t('events.heroLogoSize', 'Logo Size')}
                          </label>
                          <select
                            value={editForm.hero_logo_size}
                            onChange={(e) => setEditForm(prev => ({ ...prev, hero_logo_size: e.target.value as 'small' | 'medium' | 'large' | 'xlarge' }))}
                            className="w-full sm:w-48 px-3 py-2 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded-md shadow-sm focus:ring-primary-500 focus:border-accent-dark text-sm"
                          >
                            <option value="small">{t('events.heroLogoSizeSmall', 'Small')}</option>
                            <option value="medium">{t('events.heroLogoSizeMedium', 'Medium')}</option>
                            <option value="large">{t('events.heroLogoSizeLarge', 'Large')}</option>
                            <option value="xlarge">{t('events.heroLogoSizeXLarge', 'Extra Large')}</option>
                          </select>
                        </div>

                        <div className="ml-6">
                          <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                            {t('events.heroLogoPosition', 'Logo Position')}
                          </label>
                          <select
                            value={editForm.hero_logo_position}
                            onChange={(e) => setEditForm(prev => ({ ...prev, hero_logo_position: e.target.value as 'top' | 'center' | 'bottom' }))}
                            className="w-full sm:w-48 px-3 py-2 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded-md shadow-sm focus:ring-primary-500 focus:border-accent-dark text-sm"
                          >
                            <option value="top">{t('events.heroLogoPositionTop', 'Top (above title)')}</option>
                            <option value="center">{t('events.heroLogoPositionCenter', 'Center (between title and dates)')}</option>
                            <option value="bottom">{t('events.heroLogoPositionBottom', 'Bottom (below dates)')}</option>
                          </select>
                        </div>

                        {/* Custom Event Logo Upload */}
                        <div className="ml-6 mt-3 pt-3 border-t border-neutral-100 dark:border-neutral-700">
                          <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                            {t('events.eventCustomLogo', 'Custom Event Logo')}
                          </label>
                          <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-2">
                            {t('events.eventCustomLogoDescription', 'Upload a custom logo for this event. This overrides the global branding logo for this gallery only.')}
                          </p>

                          {event.hero_logo_url ? (
                            <div className="flex items-center gap-3">
                              <div className="w-16 h-16 border border-neutral-200 dark:border-neutral-600 rounded-md flex items-center justify-center bg-neutral-50 dark:bg-neutral-700 overflow-hidden">
                                <img
                                  src={buildResourceUrl(event.hero_logo_url)}
                                  alt={t('events.eventCustomLogo', 'Custom Event Logo')}
                                  className="max-w-full max-h-full object-contain"
                                />
                              </div>
                              <div className="flex flex-col gap-1">
                                <label className="cursor-pointer inline-flex items-center gap-1 text-xs text-accent hover:opacity-80">
                                  <Upload className="w-3 h-3" />
                                  {t('events.replaceLogo', 'Replace')}
                                  <input
                                    type="file"
                                    className="hidden"
                                    accept="image/png,image/jpeg,image/gif,image/svg+xml"
                                    disabled={logoUploading}
                                    onChange={(e) => {
                                      const file = e.target.files?.[0];
                                      if (file) handleEventLogoUpload(file);
                                      e.target.value = '';
                                    }}
                                  />
                                </label>
                                <button
                                  type="button"
                                  onClick={handleEventLogoRemove}
                                  disabled={logoUploading}
                                  className="inline-flex items-center gap-1 text-xs text-red-600 hover:text-red-700"
                                >
                                  <Trash2 className="w-3 h-3" />
                                  {t('events.removeLogo', 'Remove')}
                                </button>
                              </div>
                              {logoUploading && <Loading size="sm" />}
                            </div>
                          ) : (
                            <div className="flex items-center gap-2">
                              <label className={`cursor-pointer inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium border border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-300 rounded-md hover:bg-neutral-50 dark:hover:bg-neutral-700 ${logoUploading ? 'opacity-50 pointer-events-none' : ''}`}>
                                <Upload className="w-3.5 h-3.5" />
                                {t('events.uploadEventLogo', 'Upload Logo')}
                                <input
                                  type="file"
                                  className="hidden"
                                  accept="image/png,image/jpeg,image/gif,image/svg+xml"
                                  disabled={logoUploading}
                                  onChange={(e) => {
                                    const file = e.target.files?.[0];
                                    if (file) handleEventLogoUpload(file);
                                    e.target.value = '';
                                  }}
                                />
                              </label>
                              {logoUploading && <Loading size="sm" />}
                            </div>
                          )}
                        </div>
                      </>
                    )}

                    <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-2">
                      {t('events.heroLogoInfo', 'These settings apply when the gallery uses the Hero layout. You can hide the logo or customize its size and position.')}
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <dl className="space-y-4">
                <div>
                  <dt className="text-sm font-medium text-neutral-500 dark:text-neutral-400">{t('events.sourceMode', 'Source Mode')}</dt>
                  <dd className="mt-1 text-sm text-neutral-900 dark:text-neutral-100">
                    {event.source_mode === 'reference' ? t('events.sourceModeReference', 'Reference external folder') : t('events.sourceModeManaged', 'Managed (upload to PicPeak)')}
                    {event.source_mode === 'reference' && event.external_path ? (
                      <span className="text-neutral-500 dark:text-neutral-400 ml-2">/external-media/{event.external_path}</span>
                    ) : null}
                  </dd>
                </div>
                <div>
                  <dt className="text-sm font-medium text-neutral-500 dark:text-neutral-400">{t('events.welcomeMessage')}</dt>
                  <dd className="mt-1 text-sm text-neutral-900 dark:text-neutral-100">
                    {event.welcome_message || <span className="text-neutral-400">{t('events.noWelcomeMessageSet')}</span>}
                  </dd>
                </div>

                <div>
                  <dt className="text-sm font-medium text-neutral-500 dark:text-neutral-400">{t('events.hostName')}</dt>
                  <dd className="mt-1 text-sm text-neutral-900 dark:text-neutral-100">
                    {event.customer_name || <span className="text-neutral-400">{t('common.notSet')}</span>}
                  </dd>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <dt className="text-sm font-medium text-neutral-500 dark:text-neutral-400">{t('events.hostEmail')}</dt>
                  <dd className="mt-1 text-sm text-neutral-900 dark:text-neutral-100">{event.customer_email}</dd>
                  </div>

                  <div>
                    <dt className="text-sm font-medium text-neutral-500 dark:text-neutral-400">{t('events.adminEmail')}</dt>
                    <dd className="mt-1 text-sm text-neutral-900 dark:text-neutral-100">{event.admin_email}</dd>
                  </div>
                </div>

                {phoneFieldEnabled && (
                  <div>
                    <dt className="text-sm font-medium text-neutral-500 dark:text-neutral-400">
                      {t('events.customerPhone', 'Customer Phone')}
                    </dt>
                    <dd className="mt-1 text-sm text-neutral-900 dark:text-neutral-100">
                      {event.customer_phone || (
                        <span className="text-neutral-400">{t('common.notSet')}</span>
                      )}
                    </dd>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <dt className="text-sm font-medium text-neutral-500 dark:text-neutral-400">{t('events.created')}</dt>
                    <dd className="mt-1 text-sm text-neutral-900 dark:text-neutral-100">
                      {event.created_at && format(safeParseDate(event.created_at)!, 'PP')}
                    </dd>
                  </div>

                  <div>
                    <dt className="text-sm font-medium text-neutral-500 dark:text-neutral-400">{t('events.expires')}</dt>
                    <dd className="mt-1 text-sm text-neutral-900 dark:text-neutral-100">
                      {event.expires_at ? (
                        <>
                          {format(safeParseDate(event.expires_at)!, 'PP')}
                          {!event.is_archived && daysUntilExpiration !== null && daysUntilExpiration > 0 && (
                            <span className="text-neutral-500 dark:text-neutral-400 ml-1">
                              {t('events.daysLeft', { count: daysUntilExpiration })}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-neutral-500 dark:text-neutral-400">{t('events.neverExpires', 'Never')}</span>
                      )}
                    </dd>
                  </div>
                </div>

                <div>
                  <dt className="text-sm font-medium text-neutral-500 dark:text-neutral-400">{t('events.heroPhoto')}</dt>
                  <dd className="mt-1 text-sm text-neutral-900 dark:text-neutral-100">
                    {event.hero_photo_id ? (
                      <span className="text-accent">{t('events.heroPhotoSelected')}</span>
                    ) : (
                      <span className="text-neutral-400">{t('events.noHeroPhotoSelected')}</span>
                    )}
                  </dd>
                </div>

                <div>
                  <dt className="text-sm font-medium text-neutral-500 dark:text-neutral-400">{t('events.userUploads')}</dt>
                  <dd className="mt-1 text-sm text-neutral-900 dark:text-neutral-100">
                    {event.allow_user_uploads ? (
                      <div className="space-y-1">
                        <span className="inline-flex items-center px-2 py-1 text-xs font-medium text-green-700 dark:text-green-300 bg-green-100 dark:bg-green-900/40 rounded">
                          {t('common.yes')}
                        </span>
                        {event.upload_category_id && (
                          <p className="text-xs text-neutral-600 dark:text-neutral-400">
                            {t('events.uploadCategory')}: {categories.find(c => c.id === event.upload_category_id)?.name || 'N/A'}
                          </p>
                        )}
                      </div>
                    ) : (
                      <span className="inline-flex items-center px-2 py-1 text-xs font-medium text-neutral-700 dark:text-neutral-300 bg-neutral-100 dark:bg-neutral-700 rounded">
                        {t('common.no')}
                      </span>
                    )}
                  </dd>
                </div>

                {/* Download Protection Display */}
                <div className="pt-3 mt-3 border-t border-neutral-200 dark:border-neutral-700">
                  <dt className="text-sm font-medium text-neutral-500 dark:text-neutral-400 flex items-center gap-2">
                    <Shield className="w-4 h-4" />
                    {t('events.downloadProtection', 'Download Protection')}
                  </dt>
                  <dd className="mt-2 text-sm text-neutral-900 dark:text-neutral-100">
                    <div className="flex flex-wrap gap-2">
                      <span className={`inline-flex items-center px-2 py-1 text-xs font-medium rounded ${
                        event.protection_level === 'maximum' ? 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300' :
                        event.protection_level === 'enhanced' ? 'bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300' :
                        event.protection_level === 'standard' ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300' :
                        'bg-neutral-100 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300'
                      }`}>
                        {event.protection_level || 'standard'}
                      </span>
                      {event.disable_right_click && (
                        <span className="inline-flex items-center px-2 py-1 text-xs font-medium bg-neutral-100 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300 rounded">
                          <MousePointer className="w-3 h-3 mr-1" />
                          {t('events.rightClickBlocked', 'Right-click blocked')}
                        </span>
                      )}
                      {event.enable_devtools_protection && (
                        <span className="inline-flex items-center px-2 py-1 text-xs font-medium bg-neutral-100 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300 rounded">
                          <Monitor className="w-3 h-3 mr-1" />
                          {t('events.devtoolsDetection', 'DevTools detection')}
                        </span>
                      )}
                      {!event.allow_downloads && (
                        <span className="inline-flex items-center px-2 py-1 text-xs font-medium bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 rounded">
                          <Download className="w-3 h-3 mr-1" />
                          {t('events.downloadsDisabled', 'Downloads disabled')}
                        </span>
                      )}
                      {event.watermark_downloads && (
                        <span className="inline-flex items-center px-2 py-1 text-xs font-medium bg-neutral-100 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300 rounded">
                          <Droplets className="w-3 h-3 mr-1" />
                          {t('events.watermarked', 'Watermarked')}
                        </span>
                      )}
                    </div>
                  </dd>
                </div>

                {/* Hero Logo Settings Display */}
                <div className="pt-3 mt-3 border-t border-neutral-200 dark:border-neutral-700">
                  <dt className="text-sm font-medium text-neutral-500 dark:text-neutral-400 flex items-center gap-2">
                    <Layout className="w-4 h-4" />
                    {t('events.heroLogoSettings', 'Hero Logo Settings')}
                  </dt>
                  <dd className="mt-2 text-sm text-neutral-900 dark:text-neutral-100">
                    <div className="flex flex-wrap gap-2">
                      {event.hero_logo_visible !== false ? (
                        <>
                          <span className="inline-flex items-center px-2 py-1 text-xs font-medium bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 rounded">
                            <Image className="w-3 h-3 mr-1" />
                            {t('events.heroLogoVisibleLabel', 'Logo visible')}
                          </span>
                          <span className="inline-flex items-center px-2 py-1 text-xs font-medium bg-neutral-100 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300 rounded">
                            {t('events.heroLogoSizeLabel', 'Size')}: {event.hero_logo_size || 'medium'}
                          </span>
                          <span className="inline-flex items-center px-2 py-1 text-xs font-medium bg-neutral-100 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300 rounded">
                            {t('events.heroLogoPositionLabel', 'Position')}: {event.hero_logo_position || 'top'}
                          </span>
                        </>
                      ) : (
                        <span className="inline-flex items-center px-2 py-1 text-xs font-medium bg-neutral-100 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300 rounded">
                          <Image className="w-3 h-3 mr-1" />
                          {t('events.heroLogoHidden', 'Logo hidden')}
                        </span>
                      )}
                    </div>
                  </dd>
                </div>
              </dl>
            )}
          </Card>

          {/* Share Link */}
          <Card padding="md">
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">{t('events.shareLink')}</h2>

            <div className="flex items-center gap-2">
              <input
                type="text"
                value={buildShareLinkUrl(event.share_link)}
                readOnly
                className="flex-1 px-3 py-2 bg-neutral-50 dark:bg-neutral-700 border border-neutral-300 dark:border-neutral-600 text-neutral-900 dark:text-neutral-100 rounded-lg text-sm"
              />
              <Button
                variant="outline"
                size="md"
                leftIcon={copiedLink ? <CheckCircle className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                onClick={handleCopyLink}
              >
                {copiedLink ? t('events.copied') : t('events.copy')}
              </Button>
            </div>

            <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-2">
              {isGalleryPublic(event.require_password)
                ? t('events.shareWithGuestsPublic', 'Anyone with this link can view the gallery. No password is required.')
                : t('events.shareWithGuests')}
            </p>

            {!event.is_archived && (
              <div className="mt-4 pt-4 border-t border-neutral-200 dark:border-neutral-700 space-y-2">
                <Button
                  variant="outline"
                  size="sm"
                  leftIcon={<Key className="w-4 h-4" />}
                  onClick={() => setShowPasswordReset(true)}
                  className="w-full justify-center"
                >
                  {t('events.resetGalleryPassword')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  leftIcon={<Mail className="w-4 h-4" />}
                  onClick={async () => {
                    try {
                      await eventsService.resendCreationEmail(event.id);
                      toast.success(t('events.creationEmailResent'));
                    } catch {
                      toast.error(t('events.failedToResendEmail'));
                    }
                  }}
                  className="w-full justify-center"
                >
                  {t('events.resendCreationEmail')}
                </Button>
              </div>
            )}
          </Card>

          {/* Branded short URLs (#699). Sits between the canonical share-link
              card and the Client Access card — same "things you share with
              the customer" cluster. */}
          <ShortUrlsCard eventId={event.id} />

          {/* Client Access (#172) */}
          <Card padding="md">
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4 flex items-center gap-2">
              <Shield className="w-5 h-5" />
              {t('clientAccess.adminTitle')}
            </h2>

            <div className="space-y-4">
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1 w-4 h-4 text-accent border-neutral-300 dark:border-neutral-600 rounded focus:ring-primary-500"
                  checked={!!event?.client_access_enabled}
                  onChange={async (e) => {
                    try {
                      await eventsService.updateEvent(event.id, { client_access_enabled: e.target.checked });
                      refetchEvent();
                    } catch {
                      toast.error(t('common.error'));
                    }
                  }}
                  disabled={event?.is_archived}
                />
                <div>
                  <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                    {t('clientAccess.enableToggle')}
                  </span>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                    {t('clientAccess.enableDescription')}
                  </p>
                </div>
              </label>

              {event?.client_access_enabled && (
                <>
                  {/* Set/Change PIN */}
                  <div className="flex items-end gap-2">
                    <div className="flex-1">
                      <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                        {t('clientAccess.pinLabel')}
                      </label>
                      <input
                        type="text"
                        value={clientPin}
                        onChange={(e) => setClientPin(e.target.value)}
                        placeholder={t('clientAccess.pinPlaceholder')}
                        className="w-full px-3 py-2 bg-neutral-50 dark:bg-neutral-700 border border-neutral-300 dark:border-neutral-600 text-neutral-900 dark:text-neutral-100 rounded-lg text-sm"
                      />
                    </div>
                    <Button
                      variant="outline"
                      size="md"
                      leftIcon={<Key className="w-4 h-4" />}
                      onClick={async () => {
                        if (!clientPin.trim()) return;
                        try {
                          await eventsService.updateEvent(event.id, { client_password: clientPin });
                          setClientPin('');
                          toast.success(t('clientAccess.pinUpdated'));
                          refetchEvent();
                        } catch {
                          toast.error(t('common.error'));
                        }
                      }}
                      disabled={!clientPin.trim()}
                    >
                      {t('clientAccess.setPin')}
                    </Button>
                  </div>

                  {/* Client access link */}
                  {event?.client_share_token && (
                    <div>
                      <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                        {t('clientAccess.linkLabel')}
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={`${window.location.origin}/gallery/${event.slug}/client-access?token=${event.client_share_token}`}
                          readOnly
                          className="flex-1 px-3 py-2 bg-neutral-50 dark:bg-neutral-700 border border-neutral-300 dark:border-neutral-600 text-neutral-900 dark:text-neutral-100 rounded-lg text-sm"
                        />
                        <Button
                          variant="outline"
                          size="md"
                          leftIcon={copiedClientLink ? <CheckCircle className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                          onClick={async () => {
                            const link = `${window.location.origin}/gallery/${event.slug}/client-access?token=${event.client_share_token}`;
                            try {
                              await navigator.clipboard.writeText(link);
                            } catch {
                              const textArea = document.createElement('textarea');
                              textArea.value = link;
                              document.body.appendChild(textArea);
                              textArea.select();
                              document.execCommand('copy');
                              document.body.removeChild(textArea);
                            }
                            setCopiedClientLink(true);
                            setTimeout(() => setCopiedClientLink(false), 2000);
                          }}
                        >
                          {copiedClientLink ? t('events.copied') : t('events.copy')}
                        </Button>
                      </div>

                      <Button
                        variant="ghost"
                        size="sm"
                        className="mt-2 text-xs"
                        onClick={async () => {
                          try {
                            await eventsService.updateEvent(event.id, { regenerate_client_token: true });
                            toast.success(t('clientAccess.tokenRegenerated'));
                            refetchEvent();
                          } catch {
                            toast.error(t('common.error'));
                          }
                        }}
                      >
                        {t('clientAccess.regenerateToken')}
                      </Button>
                    </div>
                  )}
                </>
              )}
            </div>
          </Card>

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
            <Card padding="md">
              <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">{t('events.actions')}</h2>

              <div className="space-y-3">
                {event.is_draft ? (
                  <>
                    <Button
                      variant="primary"
                      leftIcon={<Send className="w-4 h-4" />}
                      onClick={() => setShowPublishDialog(true)}
                      isLoading={publishMutation.isPending}
                      className="w-full justify-center"
                    >
                      {t('events.publishAndNotify')}
                    </Button>
                    <p className="text-xs text-neutral-500 dark:text-neutral-400 text-center">
                      {t('events.draftBanner')}
                    </p>
                  </>
                ) : (
                  <>
                    <Button
                      variant="outline"
                      leftIcon={<Archive className="w-4 h-4" />}
                      onClick={() => {
                        if (confirm(t('events.archiveConfirm'))) {
                          archiveMutation.mutate();
                        }
                      }}
                      isLoading={archiveMutation.isPending}
                      className="w-full justify-center"
                    >
                      {t('events.archiveEvent')}
                    </Button>
                    <p className="text-xs text-neutral-500 dark:text-neutral-400 text-center">
                      {t('events.archivingInfo')}
                    </p>
                  </>
                )}
                {/* Duplicate (#626) — visible in both draft and live mode.
                    Creates a new draft inheriting this gallery's config. */}
                <Button
                  variant="outline"
                  leftIcon={<Copy className="w-4 h-4" />}
                  onClick={() => setShowDuplicateDialog(true)}
                  isLoading={duplicateMutation.isPending}
                  className="w-full justify-center"
                >
                  {t('events.duplicateEvent', 'Duplicate gallery')}
                </Button>
              </div>
            </Card>
          )}
        </div>

        {/* Right Column - Statistics, Theme, and Actions */}
        <div className="space-y-6">
          {/* Photo Statistics */}
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

          {/* Theme & Style */}
          {isEditing && !event.is_archived && (
            <Card padding="md">
              <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">{t('branding.themeAndStyle')}</h2>
              <ThemeCustomizerEnhanced
                value={currentTheme || GALLERY_THEME_PRESETS.default.config}
                forceColorMode={publicSettings?.branding_force_color_mode ?? null}
                onChange={(theme) => {
                  setCurrentTheme(theme);
                  setEditForm(prev => ({ ...prev, color_theme: JSON.stringify(theme) }));
                  setThemeChanged(true);
                }}
                presetName={currentPresetName}
                onPresetChange={(presetName) => {
                  setCurrentPresetName(presetName);
                  setThemeChanged(true);
                  if (presetName !== 'custom') {
                    const preset = GALLERY_THEME_PRESETS[presetName];
                    if (preset) {
                      setCurrentTheme(preset.config);
                      setEditForm(prev => ({ ...prev, color_theme: presetName }));
                    }
                  }
                }}
                onSyncFromBranding={() => {
                  // Reset only the 8 colour tokens to the site Branding —
                  // layout, header, typography all stay so the admin doesn't
                  // lose tweaks made for this specific event.
                  const branding = publicSettings?.theme_config as ThemeConfig | undefined;
                  if (!branding) {
                    toast.error(t('toast.brandingThemeMissing', 'No branding theme has been saved yet.'));
                    return;
                  }
                  const base = currentTheme || GALLERY_THEME_PRESETS.default.config;
                  const merged: ThemeConfig = {
                    ...base,
                    primaryColor: branding.primaryColor,
                    accentColor: branding.accentColor,
                    accentDarkColor: branding.accentDarkColor,
                    backgroundColor: branding.backgroundColor,
                    surfaceColor: branding.surfaceColor,
                    elevatedColor: branding.elevatedColor,
                    surfaceBorderColor: branding.surfaceBorderColor,
                    textColor: branding.textColor,
                    mutedTextColor: branding.mutedTextColor,
                    colorMode: branding.colorMode ?? base.colorMode,
                  };
                  setCurrentTheme(merged);
                  setCurrentPresetName('custom');
                  setEditForm(prev => ({ ...prev, color_theme: JSON.stringify(merged) }));
                  setThemeChanged(true);
                  toast.success(t('toast.brandingPaletteSynced', 'Palette synced from Branding.'));
                }}
                isPreviewMode={true}
                showGalleryLayouts={true}
                hideActions={true}
                cssTemplates={cssTemplates}
                cssTemplateId={editForm.css_template_id}
                onCssTemplateChange={(templateId) => setEditForm(prev => ({ ...prev, css_template_id: templateId }))}
              />
            </Card>
          )}

          {/* Theme Display (when not editing) */}
          {!isEditing && !event.is_archived && (
            <Card padding="md">
              <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">{t('events.galleryTheme')}</h2>
              <ThemeDisplay 
                theme={event.color_theme || GALLERY_THEME_PRESETS.default.config} 
                presetName={event.color_theme && !event.color_theme.startsWith('{') ? event.color_theme : undefined}
                showDetails={true}
              />
            </Card>
          )}

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
            <Card padding="md">
              <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">{t('events.archiveStatusTitle')}</h2>

              <div className="space-y-3">
                <div>
                  <p className="text-sm font-medium text-neutral-500 dark:text-neutral-400">{t('events.archivedOn')}</p>
                  <p className="text-sm text-neutral-900 dark:text-neutral-100">
                    {event.archived_at && fmtDateTime(safeParseDate(event.archived_at)!)}
                  </p>
                </div>
                
                {event.archive_path && (
                  <Button
                    variant="outline"
                    size="sm"
                    leftIcon={<Download className="w-4 h-4" />}
                    onClick={async () => {
                      try {
                        toast.info(t('events.downloadingArchive', { name: event.event_name }));
                        await archiveService.downloadArchive(Number(id), `${event.slug}-archive.zip`);
                        toast.success(t('events.downloadStarted'));
                      } catch {
                        toast.error(t('events.failedToDownloadArchive'));
                      }
                    }}
                    className="w-full justify-center"
                  >
                    {t('events.downloadArchive')}
                  </Button>
                )}
              </div>
            </Card>
          ) : null}
        </div>
      </div>
      )}

      {/* Photos Tab */}
      {activeTab === 'photos' && (
        <div>
          {/* Photo Upload Modal */}
          <PhotoUploadModal
            isOpen={showPhotoUpload}
            onClose={() => setShowPhotoUpload(false)}
            eventId={parseInt(id!)}
            onUploadComplete={() => {
              queryClient.invalidateQueries({ queryKey: ['admin-event', id] });
              queryClient.invalidateQueries({ queryKey: ['admin-event-photos', id] });
              toast.success(t('toast.uploadSuccess'));
              refetchPhotos();
            }}
          />

          {/* Photo Filters */}
          <PhotoFilters
            categories={categories}
            selectedCategory={photoFilters.category_id}
            searchTerm={photoFilters.search ?? ''}
            sortBy={photoFilters.sort ?? 'date'}
            sortOrder={photoFilters.order ?? 'desc'}
            onCategoryChange={(categoryId) => setPhotoFilters(prev => ({ ...prev, category_id: categoryId }))}
            onSearchChange={(search) => setPhotoFilters(prev => ({ ...prev, search }))}
            onSortChange={(sort, order) => setPhotoFilters(prev => ({ ...prev, sort, order }))}
            mediaType={photoFilters.media_type || 'all'}
            onMediaTypeChange={(mediaType) => setPhotoFilters(prev => ({
              ...prev,
              media_type: mediaType === 'all' ? undefined : mediaType
            }))}
            showMediaFilter={showMediaFilter}
          />

          {/* Feedback Filter Panel for Export */}
          <PhotoFilterPanel
            filters={feedbackFilters}
            onChange={setFeedbackFilters}
            summary={filterSummary || null}
            isLoading={photosLoading}
          />

          {/* Actions Bar */}
          <div className="mb-4 flex flex-wrap justify-between items-center gap-4">
            <div className="flex items-center gap-3">
              <Button
                variant="primary"
                size="sm"
                leftIcon={<Upload className="w-4 h-4" />}
                onClick={() => setShowPhotoUpload(true)}
              >
                {t('events.uploadPhotos')}
              </Button>
              {event.source_mode === 'reference' && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowExternalImport(true)}
                >
                  {t('events.importExternal', 'Import from External Folder')}
                </Button>
              )}
            </div>
            <PhotoExportMenu
              eventId={parseInt(id!)}
              selectedPhotoIds={selectedPhotoIds}
              filters={feedbackFilters}
            />
          </div>

          {/* Photo Grid */}
          {photosLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loading size="lg" text={t('events.loadingPhotos')} />
            </div>
          ) : (
            <AdminPhotoGrid
              photos={photos}
              eventId={parseInt(id!)}
              onPhotoClick={(photo, index) => setSelectedPhoto({ photo, index })}
              onPhotosDeleted={() => {
                refetchPhotos();
                queryClient.invalidateQueries({ queryKey: ['admin-event', id] });
              }}
              onSelectionChange={setSelectedPhotoIds}
              categories={categories}
            />
          )}

          {/* Photo Viewer */}
          {selectedPhoto && (
            <AdminPhotoViewer
              photos={photos}
              initialIndex={selectedPhoto.index}
              eventId={parseInt(id!)}
              onClose={() => setSelectedPhoto(null)}
              onPhotoDeleted={() => {
                refetchPhotos();
                queryClient.invalidateQueries({ queryKey: ['admin-event', id] });
                setSelectedPhoto(null);
              }}
              categories={categories}
            />
          )}
        </div>
      )}

      {/* Categories Tab */}
      {activeTab === 'categories' && (
        <div>
          <Card padding="md">
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-2">{t('events.photoCategories')}</h2>
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                {t('events.organizeCategoriesInfo')}
              </p>
            </div>

            <EventCategoryManager
              eventId={parseInt(id!)}
            />

            <div className="mt-6 p-4 bg-blue-50 dark:bg-blue-900/30 rounded-lg">
              <p className="text-sm text-blue-800 dark:text-blue-300">
                {t('events.categoriesTip')}
              </p>
            </div>
          </Card>
        </div>
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

      {/* External Import Modal */}
      {showExternalImport && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <Card className="max-w-2xl w-full">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">{t('events.importExternal', 'Import from External Folder')}</h2>
              <button onClick={() => setShowExternalImport(false)} className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="mb-3 text-sm text-neutral-700 dark:text-neutral-300">
              {t('events.externalImportInfo', 'All pictures from the selected folder will be imported.')}
            </div>
            <div className="mb-2 text-sm text-neutral-700 dark:text-neutral-300">
              {t('events.selectExternalFolder', 'Select external folder under /external-media')}
            </div>
            <ExternalFolderPicker value={externalPath || event.external_path || ''} onChange={setExternalPath} />

            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowExternalImport(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="primary"
                isLoading={importing}
                onClick={async () => {
                  try {
                    setImporting(true);
                    const selected = externalPath || event.external_path || '';
                    if (!selected) {
                      toast.error(t('errors.somethingWentWrong', 'Something went wrong'));
                      return;
                    }
                    await externalMediaService.importEvent(parseInt(id!), selected, { recursive: true });
                    toast.success(t('toast.saveSuccess'));
                    queryClient.invalidateQueries({ queryKey: ['admin-event', id] });
                    queryClient.invalidateQueries({ queryKey: ['admin-event-photos', id] });
                    setShowExternalImport(false);
                  } catch (e: any) {
                    toast.error(e?.response?.data?.error || 'Import failed');
                  } finally {
                    setImporting(false);
                  }
                }}
              >
                {t('events.importFromSelectedFolder', 'Import from selected folder')}
              </Button>
            </div>
          </Card>
        </div>
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
