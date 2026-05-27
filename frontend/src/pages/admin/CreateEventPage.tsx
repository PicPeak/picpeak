import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  Calendar,
  Mail,
  Lock,
  Clock,
  ArrowLeft,
  Palette,
  Eye,
  EyeOff,
  Image,
  Key
} from 'lucide-react';
import { addDays } from 'date-fns';
import { toast } from 'react-toastify';

import { Button, Input, Card, PasswordGenerator } from '../../components/common';
import { ThemeCustomizerEnhanced, GalleryPreview, WelcomeMessageEditor, FeedbackSettings } from '../../components/admin';
import { CustomerAccountPicker } from '../../components/admin/CustomerAccountPicker';
import { useMutation, useQuery } from '@tanstack/react-query';
import { eventsService } from '../../services/events.service';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { categoriesService } from '../../services/categories.service';
import { settingsService } from '../../services/settings.service';
import { usePublicSettings } from '../../hooks/usePublicSettings';
import { cssTemplatesService } from '../../services/cssTemplates.service';
import { eventTypesService } from '../../services/eventTypes.service';
import { userManagementService } from '../../services/userManagement.service';
import { useAdminAuth } from '../../contexts/AdminAuthContext';
import { useTranslation } from 'react-i18next';
import { ThemeConfig, GALLERY_THEME_PRESETS } from '../../types/theme.types';
import { Code } from 'lucide-react';

interface FormData {
  event_type: string;
  event_name: string;
  event_date: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  admin_email: string;
  require_password: boolean;
  password: string;
  confirm_password: string;
  welcome_message: string;
  theme_preset: string;
  theme_config: ThemeConfig;
  expires_in_days: number;
  allow_user_uploads: boolean;
  upload_category_id: number | null;
  css_template_id: number | null;
  photo_cap: number;
  feedback_settings: {
    feedback_enabled: boolean;
    allow_ratings: boolean;
    allow_likes: boolean;
    allow_comments: boolean;
    allow_favorites: boolean;
    require_name_email: boolean;
    moderate_comments: boolean;
    show_feedback_to_guests: boolean;
    enable_rate_limiting: boolean;
    rate_limit_window_minutes?: number;
    rate_limit_max_requests?: number;
  };
  // Client access (#172)
  client_access_enabled: boolean;
  client_password: string;
  // Default photo sort
  default_photo_sort: string;
  // Customer accounts assigned to this event (#354). The state holds
  // the full picker selection so chips render without an extra fetch;
  // only the ids are sent to the backend on submit.
  customer_accounts: Array<{ id: number; email: string; displayName: string | null }>;
}

// Fallback event types (used when API is unavailable)
const FALLBACK_EVENT_TYPES = [
  { value: 'wedding', name: 'Wedding', emoji: '💒', theme_preset: 'elegantWedding' },
  { value: 'birthday', name: 'Birthday', emoji: '🎂', theme_preset: 'birthdayFun' },
  { value: 'corporate', name: 'Corporate', emoji: '🏢', theme_preset: 'corporateTimeline' },
  { value: 'other', name: 'Other', emoji: '📸', theme_preset: 'default' },
];

export const CreateEventPage: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { format } = useLocalizedDate();
  const isMountedRef = useRef(true);
  const [showThemeCustomizer, setShowThemeCustomizer] = useState(false);
  // const [showPreview, setShowPreview] = useState(false);
  
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);
  
  const [formData, setFormData] = useState<FormData>({
    event_type: 'wedding',
    event_name: '',
    event_date: new Date().toISOString().split('T')[0], // Initialize with ISO date format
    customer_name: '',
    customer_email: '',
    customer_phone: '',
    admin_email: '',
    require_password: true,
    password: '',
    confirm_password: '',
    welcome_message: '',
    theme_preset: 'elegantWedding',
    theme_config: GALLERY_THEME_PRESETS.elegantWedding.config,
    expires_in_days: 30,
    allow_user_uploads: false,
    upload_category_id: null,
    css_template_id: null,
    photo_cap: 0,
    feedback_settings: {
      feedback_enabled: false,
      allow_ratings: true,
      allow_likes: true,
      allow_comments: true,
      allow_favorites: true,
      require_name_email: false,
      moderate_comments: true,
      show_feedback_to_guests: true,
      enable_rate_limiting: true,
      rate_limit_window_minutes: 15,
      rate_limit_max_requests: 10,
    },
    client_access_enabled: false,
    client_password: '',
    default_photo_sort: 'upload_date_desc',
    customer_accounts: [],
  });

  const [errors, setErrors] = useState<Partial<Record<keyof FormData, string>>>({});
  const [showPassword, setShowPassword] = useState(false);

  // Fetch categories for user upload selection
  const { data: categories } = useQuery({
    queryKey: ['categories', 'global'],
    queryFn: () => categoriesService.getGlobalCategories()
  });

  // Fetch enabled CSS templates
  const { data: cssTemplates } = useQuery({
    queryKey: ['css-templates', 'enabled'],
    queryFn: () => cssTemplatesService.getEnabledTemplates()
  });

  // Fetch event types
  const { data: eventTypes } = useQuery({
    queryKey: ['event-types', 'active'],
    queryFn: () => eventTypesService.getActiveEventTypes()
  });

  // Compute event types to use (API data or fallback). Memoised so its
  // identity is stable across renders — otherwise the "Update theme when
  // event type changes" effect below re-runs on every render and silently
  // overwrites the user's Theme Preset selection (#317).
  const availableEventTypes = useMemo(
    () => (eventTypes?.length
      ? eventTypes.map(et => ({
          value: et.slug_prefix,
          name: et.name,
          emoji: et.emoji,
          theme_preset: et.theme_preset
        }))
      : FALLBACK_EVENT_TYPES),
    [eventTypes]
  );

  // Fetch default settings
  const { data: settings } = useQuery({
    queryKey: ['admin-settings'],
    queryFn: () => settingsService.getAllSettings()
  });

  const { data: publicSettings } = usePublicSettings();

  // Current logged-in admin (used to prefill the admin email field)
  const { user: currentAdmin } = useAdminAuth();

  // Optional: list of admin users — used to populate the email picker when
  // there are multiple admins. Falls back to an empty list silently if the
  // current user lacks `users.view` permission, so basic admins still get
  // the auto-prefill from `currentAdmin` without errors surfacing.
  const { data: adminUsers } = useQuery({
    queryKey: ['admin-users-list'],
    queryFn: async () => {
      try {
        return await userManagementService.getUsers();
      } catch {
        return [];
      }
    },
    staleTime: 5 * 60 * 1000,
    retry: false
  });

  const activeAdmins = useMemo(
    () => (adminUsers || []).filter(u => u.isActive !== false && !!u.email),
    [adminUsers]
  );

  // Auto-prefill admin email with the current user's email exactly once,
  // and only if the field is still empty (don't clobber typed input).
  const didPrefillAdminEmailRef = useRef(false);
  useEffect(() => {
    if (didPrefillAdminEmailRef.current) return;
    if (!currentAdmin?.email) return;
    didPrefillAdminEmailRef.current = true;
    setFormData(prev => (prev.admin_email ? prev : { ...prev, admin_email: currentAdmin.email }));
  }, [currentAdmin?.email]);

  // Get field requirements (default to true if not set)
  const requireCustomerName = publicSettings?.event_require_customer_name !== false;
  const requireCustomerEmail = publicSettings?.event_require_customer_email !== false;
  const phoneFieldEnabled = publicSettings?.event_phone_field_enabled === true;
  const requireAdminEmail = publicSettings?.event_require_admin_email !== false;
  const requireEventDate = publicSettings?.event_require_event_date !== false;
  const requireExpiration = publicSettings?.event_require_expiration !== false;

  // Update default expiration days when settings are loaded
  useEffect(() => {
    if (settings?.general_default_expiration_days) {
      setFormData(prev => ({
        ...prev,
        expires_in_days: settings.general_default_expiration_days
      }));
    }
  }, [settings]);

  // Honour the global "Require password by default" admin setting (#317).
  // Apply once when public settings first load, before the user has interacted.
  const requirePasswordDefaultApplied = useRef(false);
  useEffect(() => {
    if (requirePasswordDefaultApplied.current) return;
    if (publicSettings?.event_default_require_password === undefined) return;
    requirePasswordDefaultApplied.current = true;
    setFormData(prev => ({
      ...prev,
      require_password: publicSettings.event_default_require_password !== false
    }));
  }, [publicSettings]);

  // Honour the global "Enable Guest Feedback by default" admin setting (#520).
  // Same one-shot apply pattern as require_password above — only seeds the
  // master toggle. The sub-toggles (likes / ratings / comments) keep their
  // hard-coded true defaults so a flipped master immediately gives sensible
  // behaviour without a second admin setting to manage.
  const feedbackEnabledDefaultApplied = useRef(false);
  useEffect(() => {
    if (feedbackEnabledDefaultApplied.current) return;
    if (publicSettings?.event_default_feedback_enabled === undefined) return;
    feedbackEnabledDefaultApplied.current = true;
    setFormData(prev => ({
      ...prev,
      feedback_settings: {
        ...prev.feedback_settings,
        feedback_enabled: publicSettings.event_default_feedback_enabled === true
      }
    }));
  }, [publicSettings]);

  // Apply the global Branding default theme on first load so admins who set a
  // site-wide default in Branding actually see it on new events (#323).
  // This is the "always inherit colours from Branding" guarantee — every new
  // gallery starts with the site palette unless the admin then picks a preset
  // or hits Sync from Branding inside the customizer to re-pull it later.
  //
  // Track the last theme_config we applied as a stringified hash rather than
  // a boolean ref. React Query can hand us cached (stale) settings on first
  // observer render and then push fresh data once the network call resolves;
  // a boolean ref locks in the stale theme and ignores the fresh one (#323-B
  // / smoke spec 07). With a hash, we re-apply when the source actually
  // changes — including the stale → fresh transition — but skip when nothing
  // new has arrived.
  const lastAppliedThemeHashRef = useRef<string | null>(null);
  useEffect(() => {
    const brandingTheme = settings?.theme_config as ThemeConfig | undefined;
    if (!brandingTheme || Object.keys(brandingTheme).length === 0) return;
    const hash = JSON.stringify(brandingTheme);
    if (lastAppliedThemeHashRef.current === hash) return;
    lastAppliedThemeHashRef.current = hash;

    // Identify which preset (if any) the Branding theme matches. Compare
    // only on the preset's own fields so saved themes carrying extras
    // (e.g. logoUrl preserved through preset changes) still match.
    let matchedPreset = 'custom';
    for (const [key, preset] of Object.entries(GALLERY_THEME_PRESETS)) {
      const keys = Object.keys(preset.config);
      const matches = keys.every((k) =>
        JSON.stringify((preset.config as any)[k]) === JSON.stringify((brandingTheme as any)[k])
      );
      if (matches) {
        matchedPreset = key;
        break;
      }
    }

    setFormData(prev => ({
      ...prev,
      theme_preset: matchedPreset,
      theme_config: brandingTheme
    }));
  }, [settings]);

  // Update theme when the user actively changes the event type — but only
  // when the new type has an explicit recommended preset. Skips both the
  // generic 'default' (so types like "Other" don't clobber the global
  // Branding theme with Classic Grid) and the very first render (so the
  // wedding default doesn't out-race the Branding-default effect above
  // when eventTypes resolves AFTER settings — #323-B / smoke spec 07).
  const prevEventTypeRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevEventTypeRef.current;
    prevEventTypeRef.current = formData.event_type;
    // First render: just record the initial value and let the
    // Branding-default effect own the theme. Without this guard the
    // initial-mount fire of this effect (and any later eventTypes
    // refetch that swaps `availableEventTypes` identity) would
    // overwrite the Branding theme with the wedding preset.
    if (prev === null || prev === formData.event_type) return;

    const selectedType = availableEventTypes.find(t => t.value === formData.event_type);
    const recommendedPreset = selectedType?.theme_preset;

    if (recommendedPreset && recommendedPreset !== 'default' && GALLERY_THEME_PRESETS[recommendedPreset]) {
      setFormData(prev => ({
        ...prev,
        theme_preset: recommendedPreset,
        theme_config: GALLERY_THEME_PRESETS[recommendedPreset].config
      }));
    }
  }, [formData.event_type, availableEventTypes]);

  const createMutation = useMutation({
    mutationFn: eventsService.createEvent,
    onSuccess: (data) => {
      if (isMountedRef.current) {
        toast.success(t('toast.eventCreated'));
        navigate(`/admin/events/${data.id}`);
      }
    },
    onError: (error: any) => {
      const errorMessage = error.response?.data?.error || error.message || t('errors.eventCreationFailed');
      
      // If validation errors exist, show them
      if (error.response?.data?.errors) {
        const validationErrors = error.response.data.errors;
        validationErrors.forEach((err: any) => {
          toast.error(`${err.param}: ${err.msg}`);
        });
      } else {
        toast.error(errorMessage);
      }
    },
  });

  const validateForm = (): boolean => {
    const newErrors: Partial<Record<keyof FormData, string>> = {};

    if (!formData.event_name) {
      newErrors.event_name = t('validation.eventNameRequired');
    }

    if (requireEventDate && !formData.event_date) {
      newErrors.event_date = t('validation.eventDateRequired');
    }

    // Conditional validation based on settings
    if (requireCustomerName && !formData.customer_name) {
      newErrors.customer_name = t('validation.hostNameRequired');
    }

    if (requireCustomerEmail) {
      if (!formData.customer_email) {
        newErrors.customer_email = t('validation.hostEmailRequired');
      } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.customer_email)) {
        newErrors.customer_email = t('validation.invalidEmailFormat');
      }
    } else if (formData.customer_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.customer_email)) {
      // Still validate format if value is provided, even if optional
      newErrors.customer_email = t('validation.invalidEmailFormat');
    }

    if (requireAdminEmail) {
      if (!formData.admin_email) {
        newErrors.admin_email = t('validation.adminEmailRequired');
      } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.admin_email)) {
        newErrors.admin_email = t('validation.invalidEmailFormat');
      }
    } else if (formData.admin_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.admin_email)) {
      // Still validate format if value is provided, even if optional
      newErrors.admin_email = t('validation.invalidEmailFormat');
    }

    if (formData.require_password) {
      if (!formData.password) {
        newErrors.password = t('validation.passwordRequired');
      } else if (formData.password.length < 6) {
        newErrors.password = t('validation.passwordMinLength');
      } else if (/^\d{1,6}$/.test(formData.password)) {
        // Prevent simple numeric passwords like "123456"
        newErrors.password = t('validation.passwordTooSimple', 'Password cannot be just numbers. Consider using a date format like "04.07.2025"');
      }

      if (formData.password !== formData.confirm_password) {
        newErrors.confirm_password = t('validation.passwordsDoNotMatch');
      }
    }

    if (requireExpiration && (formData.expires_in_days < 1 || formData.expires_in_days > 365)) {
      newErrors.expires_in_days = t('validation.expirationRange');
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!validateForm()) {
      return;
    }

    const feedbackSettings = formData.feedback_settings;

    const payload = {
      event_type: formData.event_type,
      event_name: formData.event_name,
      event_date: formData.event_date || undefined,
      customer_name: formData.customer_name,
      customer_email: formData.customer_email,
      ...(phoneFieldEnabled && formData.customer_phone ? { customer_phone: formData.customer_phone.trim() } : {}),
      admin_email: formData.admin_email,
      require_password: formData.require_password,
      password: formData.require_password ? formData.password : undefined,
      welcome_message: formData.welcome_message || '',
      color_theme: JSON.stringify(formData.theme_config),
      header_style: formData.theme_config.headerStyle || 'standard',
      hero_divider_style: formData.theme_config.heroDividerStyle || 'wave',
      expiration_days: requireExpiration ? formData.expires_in_days : undefined,
      allow_user_uploads: formData.allow_user_uploads,
      upload_category_id: formData.upload_category_id,
      css_template_id: formData.css_template_id,
      photo_cap: formData.photo_cap > 0 ? formData.photo_cap : null,
      feedback_enabled: feedbackSettings.feedback_enabled,
      allow_ratings: feedbackSettings.allow_ratings,
      allow_likes: feedbackSettings.allow_likes,
      allow_comments: feedbackSettings.allow_comments,
      allow_favorites: feedbackSettings.allow_favorites,
      require_name_email: feedbackSettings.require_name_email,
      moderate_comments: feedbackSettings.moderate_comments,
      show_feedback_to_guests: feedbackSettings.show_feedback_to_guests,
      // Client access (#172)
      client_access_enabled: formData.client_access_enabled,
      client_password: formData.client_access_enabled ? formData.client_password : undefined,
      // Default photo sort
      default_photo_sort: formData.default_photo_sort,
      // Customer accounts assigned to this event (#354). Sent as a flat
      // array of ids; the backend service diffs against the existing
      // assignments and applies adds/removes inside one transaction.
      customer_account_ids: formData.customer_accounts.map((c) => c.id),
    };

    createMutation.mutate(payload);
  };

  const handleInputChange = (field: keyof FormData) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>
  ) => {
    setFormData({ ...formData, [field]: e.target.value });
    setErrors({ ...errors, [field]: undefined });
  };

  const handleThemeChange = (newTheme: ThemeConfig) => {
    setFormData(prev => ({
      ...prev,
      theme_config: newTheme
    }));
  };

  const handlePresetChange = (presetName: string) => {
    const preset = GALLERY_THEME_PRESETS[presetName];
    if (preset) {
      setFormData(prev => ({
        ...prev,
        theme_preset: presetName,
        theme_config: preset.config
      }));
    }
  };

  const handlePasswordGenerated = (password: string) => {
    setFormData(prev => ({ 
      ...prev, 
      password: password,
      confirm_password: password 
    }));
    
    // Clear password errors since we generated a valid one
    if (errors.password || errors.confirm_password) {
      setErrors(prev => ({ 
        ...prev, 
        password: undefined,
        confirm_password: undefined 
      }));
    }
  };

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<ArrowLeft className="w-4 h-4" />}
            onClick={() => navigate('/admin/events')}
          >
            {t('common.back')}
          </Button>
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">{t('events.create')}</h1>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Event Details */}
        <Card>
          <div className="p-6 space-y-6">
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 flex items-center gap-2">
              <Calendar className="w-5 h-5" />
              {t('events.eventDetails')}
            </h2>

            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                {t('events.eventType')}
              </label>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {availableEventTypes.map((type) => (
                  <button
                    key={type.value}
                    type="button"
                    onClick={() => setFormData({ ...formData, event_type: type.value })}
                    className={`p-4 rounded-lg border-2 transition-all ${
                      formData.event_type === type.value
                        ? 'tile-selected'
                        : 'border-neutral-200 dark:border-neutral-700 hover:border-neutral-300 dark:hover:border-neutral-600'
                    }`}
                  >
                    <div className="text-2xl mb-1">{type.emoji}</div>
                    <div className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{type.name}</div>
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input
                label={t('events.eventName')}
                placeholder={t('events.eventNamePlaceholder')}
                value={formData.event_name}
                onChange={handleInputChange('event_name')}
                error={errors.event_name}
                leftIcon={<Calendar className="w-5 h-5" />}
              />

              <Input
                type="date"
                label={requireEventDate ? t('events.eventDate') : `${t('events.eventDate')} (${t('common.optional')})`}
                value={formData.event_date}
                onChange={handleInputChange('event_date')}
                error={errors.event_date}
                leftIcon={<Calendar className="w-5 h-5" />}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                {t('events.welcomeMessage')}
              </label>
              <WelcomeMessageEditor
                value={formData.welcome_message}
                onChange={(value) => setFormData(prev => ({ ...prev, welcome_message: value }))}
                placeholder={t('events.welcomeMessagePlaceholder')}
                rows={4}
              />
            </div>
          </div>
        </Card>

        {/* Theme Selection */}
        <Card>
          <div className="p-6 space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 flex items-center gap-2">
                <Palette className="w-5 h-5" />
                {t('events.themeAndStyle')}
              </h2>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setShowThemeCustomizer(!showThemeCustomizer)}
                leftIcon={showThemeCustomizer ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              >
                {showThemeCustomizer ? t('common.hide') : t('common.customize')}
              </Button>
            </div>

            {/* Quick Theme Preview */}
            {!showThemeCustomizer && (
              <div className="p-4 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-semibold text-neutral-900 dark:text-neutral-100" style={{ fontFamily: formData.theme_config.fontFamily }}>
                    {GALLERY_THEME_PRESETS[formData.theme_preset]?.name || 'Custom Theme'}
                  </h3>
                  <div className="flex gap-2">
                    <div 
                      className="w-6 h-6 rounded-full border-2 border-white shadow-sm"
                      style={{ backgroundColor: formData.theme_config.primaryColor }}
                    />
                    <div 
                      className="w-6 h-6 rounded-full border-2 border-white shadow-sm"
                      style={{ backgroundColor: formData.theme_config.accentColor }}
                    />
                  </div>
                </div>
                <p className="text-sm text-neutral-600 dark:text-neutral-400">
                  Gallery Layout: <span className="font-medium capitalize">{formData.theme_config.galleryLayout || 'grid'}</span>
                </p>
              </div>
            )}

            {/* Theme Customizer */}
            {showThemeCustomizer && (
              <div className="space-y-6">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  {/* Theme Customizer */}
                  <ThemeCustomizerEnhanced
                    value={formData.theme_config}
                    onChange={handleThemeChange}
                    presetName={formData.theme_preset}
                    onPresetChange={handlePresetChange}
                    showGalleryLayouts={true}
                    hideActions={true}
                    onSyncFromBranding={() => {
                      // Pull the 8 colour tokens (+ legacy primary alias) from
                      // the global Branding theme into the current event theme.
                      // Layout / header / typography are kept untouched so an
                      // admin who has already arranged structure can refresh
                      // just the palette.
                      const branding = settings?.theme_config as ThemeConfig | undefined;
                      if (!branding) {
                        toast.error(t('toast.brandingThemeMissing', 'No branding theme has been saved yet.'));
                        return;
                      }
                      setFormData(prev => ({
                        ...prev,
                        theme_preset: 'custom',
                        theme_config: {
                          ...prev.theme_config,
                          primaryColor: branding.primaryColor,
                          accentColor: branding.accentColor,
                          accentDarkColor: branding.accentDarkColor,
                          backgroundColor: branding.backgroundColor,
                          surfaceColor: branding.surfaceColor,
                          elevatedColor: branding.elevatedColor,
                          surfaceBorderColor: branding.surfaceBorderColor,
                          textColor: branding.textColor,
                          mutedTextColor: branding.mutedTextColor,
                          colorMode: branding.colorMode ?? prev.theme_config.colorMode,
                        },
                      }));
                      toast.success(t('toast.brandingPaletteSynced', 'Palette synced from Branding.'));
                    }}
                  />
                  
                  {/* Gallery Preview */}
                  <div className="lg:sticky lg:top-4 lg:h-fit">
                    <GalleryPreview 
                      theme={formData.theme_config} 
                      className="shadow-lg" 
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Custom CSS Template Selection */}
            {cssTemplates && cssTemplates.length > 0 && (
              <div className="pt-6 border-t border-neutral-200 dark:border-neutral-700">
                <h3 className="text-md font-semibold text-neutral-900 dark:text-neutral-100 mb-3 flex items-center gap-2">
                  <Code className="w-4 h-4" />
                  {t('events.customCssTemplate', 'Custom CSS Template')}
                </h3>
                <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
                  {t('events.customCssTemplateDesc', 'Apply a custom CSS template to style the gallery with unique visual effects.')}
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {/* No template option */}
                  <button
                    type="button"
                    onClick={() => setFormData({ ...formData, css_template_id: null })}
                    className={`p-4 rounded-lg border-2 transition-all text-left ${
                      formData.css_template_id === null
                        ? 'tile-selected'
                        : 'border-neutral-200 dark:border-neutral-700 hover:border-neutral-300 dark:hover:border-neutral-600'
                    }`}
                  >
                    <div className="font-medium text-sm text-neutral-900 dark:text-neutral-100">{t('events.noTemplate', 'No Template')}</div>
                    <div className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                      {t('events.useThemeOnly', 'Use theme preset only')}
                    </div>
                  </button>

                  {/* Available templates */}
                  {cssTemplates.map(template => (
                    <button
                      key={template.id}
                      type="button"
                      onClick={() => setFormData({ ...formData, css_template_id: template.id })}
                      className={`p-4 rounded-lg border-2 transition-all text-left ${
                        formData.css_template_id === template.id
                          ? 'tile-selected'
                          : 'border-neutral-200 dark:border-neutral-700 hover:border-neutral-300 dark:hover:border-neutral-600'
                      }`}
                    >
                      <div className="font-medium text-sm text-neutral-900 dark:text-neutral-100">{template.name}</div>
                      <div className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                        {t('events.customTemplate', 'Custom Template')} {template.slot_number}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Card>

        {/* Access & Security */}
        <Card>
          <div className="p-6 space-y-6">
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 flex items-center gap-2">
              <Lock className="w-5 h-5" />
              {t('events.accessAndSecurity')}
            </h2>

            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Input
                  label={requireCustomerName ? t('events.hostName') : `${t('events.hostName')} (${t('common.optional')})`}
                  placeholder={t('events.hostNamePlaceholder')}
                  value={formData.customer_name}
                  onChange={handleInputChange('customer_name')}
                  error={errors.customer_name}
                  leftIcon={<Calendar className="w-5 h-5" />}
                />

                <Input
                  type="email"
                  label={requireCustomerEmail ? t('events.hostEmail') : `${t('events.hostEmail')} (${t('common.optional')})`}
                  placeholder={t('events.hostEmailPlaceholder')}
                  value={formData.customer_email}
                  onChange={handleInputChange('customer_email')}
                  error={errors.customer_email}
                  leftIcon={<Mail className="w-5 h-5" />}
                />
              </div>

              {phoneFieldEnabled && (
                <Input
                  type="tel"
                  label={`${t('events.customerPhone', 'Customer Phone')} (${t('common.optional')})`}
                  placeholder={t('events.customerPhonePlaceholder', '+1 555 555 1234')}
                  value={formData.customer_phone}
                  onChange={handleInputChange('customer_phone')}
                />
              )}

              {/* Customer accounts (#354). The picker is decoupled from
                  the freeform customer_name / customer_email fields above
                  — those stay as the event's primary contact while
                  customer_account_ids drives login-level access. */}
              <CustomerAccountPicker
                value={formData.customer_accounts}
                onChange={(next) => setFormData((prev) => ({ ...prev, customer_accounts: next }))}
              />

              <Input
                type="email"
                label={requireAdminEmail ? t('events.adminEmail') : `${t('events.adminEmail')} (${t('common.optional')})`}
                placeholder={t('events.adminEmailPlaceholder')}
                value={formData.admin_email}
                onChange={handleInputChange('admin_email')}
                error={errors.admin_email}
                leftIcon={<Mail className="w-5 h-5" />}
              />
              {activeAdmins.length > 1 && (
                <div className="flex items-center gap-2 -mt-1">
                  <label htmlFor="admin-email-picker" className="text-xs text-neutral-600 dark:text-neutral-400 whitespace-nowrap">
                    {t('events.adminEmailPickFromAdmins', 'Pick from admins:')}
                  </label>
                  <select
                    id="admin-email-picker"
                    value={activeAdmins.some(a => a.email === formData.admin_email) ? formData.admin_email : ''}
                    onChange={(e) => {
                      const email = e.target.value;
                      if (email) {
                        setFormData(prev => ({ ...prev, admin_email: email }));
                      }
                    }}
                    className="text-xs px-2 py-1 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded focus:ring-2 focus:ring-primary-500 focus:border-accent-dark"
                  >
                    <option value="">{t('events.adminEmailCustom', 'Custom email')}</option>
                    {activeAdmins.map(a => (
                      <option key={a.id} value={a.email}>
                        {a.username} ({a.email})
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            <div className="space-y-3">
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1 w-4 h-4 text-accent border-neutral-300 dark:border-neutral-600 rounded focus:ring-primary-500"
                  checked={formData.require_password}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setFormData(prev => ({
                      ...prev,
                      require_password: checked,
                      password: checked ? prev.password : '',
                      confirm_password: checked ? prev.confirm_password : '',
                    }));
                    if (!checked) {
                      setErrors(prev => ({ ...prev, password: undefined, confirm_password: undefined }));
                    }
                  }}
                />
                <div>
                  <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                    {t('events.requirePasswordToggle')}
                  </span>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                    {t('events.requirePasswordToggleHelp', 'Disable this if you want to share the gallery without a password. Anyone with the link will be able to view the photos.')}
                  </p>
                </div>
              </label>

              {!formData.require_password && (
                <div className="rounded-md border border-orange-200 dark:border-orange-800 bg-orange-50 dark:bg-orange-900/30 p-3 text-xs text-orange-800 dark:text-orange-300">
                  {t('events.publicGalleryWarning', 'Public galleries are accessible to anyone with the link. Consider enabling download watermarks and monitoring activity.')} 
                </div>
              )}
            </div>

            {formData.require_password && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Input
                    type={showPassword ? 'text' : 'password'}
                    label={t('events.galleryPassword')}
                    placeholder={t('events.passwordPlaceholder')}
                    value={formData.password}
                    onChange={handleInputChange('password')}
                    error={errors.password}
                    helperText={t('events.passwordHelperText', 'You can use dates like "04.07.2025" or any text with 6+ characters')}
                    leftIcon={<Lock className="w-5 h-5" />}
                    rightIcon={
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="p-1"
                      >
                        {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                      </button>
                    }
                  />
                  
                  {/* Password Generator */}
                  <div className="mt-2">
                    <PasswordGenerator
                      eventName={formData.event_name}
                      eventDate={formData.event_date}
                      eventType={formData.event_type}
                      onPasswordGenerated={handlePasswordGenerated}
                      passwordComplexity="moderate"
                      className="w-full"
                    />
                  </div>
                </div>

                <Input
                  type={showPassword ? 'text' : 'password'}
                  label={t('events.confirmPassword')}
                  placeholder={t('events.confirmPasswordPlaceholder')}
                  value={formData.confirm_password}
                  onChange={handleInputChange('confirm_password')}
                  error={errors.confirm_password}
                  leftIcon={<Lock className="w-5 h-5" />}
                />
              </div>
            )}

            {requireExpiration ? (
              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                  {t('events.galleryExpiration')}
                </label>
                <div className="flex items-center gap-2">
                  <div className="w-32">
                    <Input
                      type="number"
                      value={formData.expires_in_days}
                      onChange={handleInputChange('expires_in_days')}
                      error={errors.expires_in_days}
                      min={1}
                      max={365}
                      leftIcon={<Clock className="w-5 h-5" />}
                    />
                  </div>
                  <span className="text-sm text-neutral-600 dark:text-neutral-400">{t('events.daysAfterEvent')}</span>
                </div>
                {formData.event_date && (
                  <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
                    {/* Coerce to Number — handleInputChange stores the
                        <input type="number"> value as a string, and date-fns
                        addDays does `_date.setDate(_date.getDate() + amount)`
                        which string-concatenates (25 + "120" = "25120") and
                        ends up ~68 years in the future. */}
                    {t('events.expiresOn')}: {format(addDays(new Date(formData.event_date), Number(formData.expires_in_days)))}
                  </p>
                )}
              </div>
            ) : (
              <div className="rounded-md border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/30 p-3">
                <div className="flex items-center gap-2 text-blue-800 dark:text-blue-300">
                  <Clock className="w-4 h-4" />
                  <span className="text-sm font-medium">{t('events.noExpiration', 'No Expiration')}</span>
                </div>
                <p className="mt-1 text-xs text-blue-700 dark:text-blue-400">
                  {t('events.noExpirationHelp', 'This gallery will remain active until manually archived.')}
                </p>
              </div>
            )}

            {/* Photo Cap */}
            <div className="pt-4 border-t border-neutral-200 dark:border-neutral-700">
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                {t('events.photoCap', 'Photo Limit')}
              </label>
              <div className="flex items-center gap-2">
                <div className="w-32">
                  <Input
                    type="number"
                    value={formData.photo_cap}
                    onChange={(e) => setFormData({ ...formData, photo_cap: parseInt(e.target.value) || 0 })}
                    min={0}
                    leftIcon={<Image className="w-5 h-5" />}
                  />
                </div>
                <span className="text-sm text-neutral-600 dark:text-neutral-400">
                  {t('events.photoCapHelp', 'Maximum number of photos allowed. 0 = unlimited')}
                </span>
              </div>
            </div>

            {/* Default Photo Sort */}
            <div className="pt-4 border-t border-neutral-200 dark:border-neutral-700">
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                {t('photoSort.defaultSort', 'Default Photo Sort')}
              </label>
              <select
                value={formData.default_photo_sort}
                onChange={(e) => setFormData({ ...formData, default_photo_sort: e.target.value })}
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

            {/* Client Access (#172) */}
            <div className="pt-4 border-t border-neutral-200 dark:border-neutral-700">
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1 w-4 h-4 text-accent border-neutral-300 dark:border-neutral-600 rounded focus:ring-primary-500"
                  checked={formData.client_access_enabled}
                  onChange={(e) => setFormData(prev => ({
                    ...prev,
                    client_access_enabled: e.target.checked,
                    client_password: e.target.checked ? prev.client_password : '',
                  }))}
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

              {formData.client_access_enabled && (
                <div className="mt-3">
                  <Input
                    type="text"
                    label={t('clientAccess.pinLabel')}
                    placeholder={t('clientAccess.pinPlaceholder')}
                    value={formData.client_password}
                    onChange={handleInputChange('client_password')}
                    leftIcon={<Key className="w-5 h-5" />}
                    helperText={t('clientAccess.pinHelperText')}
                  />
                </div>
              )}
            </div>

            {/* User Upload Settings */}
            <div className="pt-4 border-t border-neutral-200 dark:border-neutral-700">
              <label className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={formData.allow_user_uploads}
                  onChange={(e) => setFormData({ ...formData, allow_user_uploads: e.target.checked })}
                  className="rounded border-neutral-300 dark:border-neutral-600 text-accent focus:ring-primary-500"
                />
                <div>
                  <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                    {t('events.allowUserUploads')}
                  </span>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                    {t('events.allowUserUploadsDescription')}
                  </p>
                </div>
              </label>

              {formData.allow_user_uploads && categories && categories.length > 0 && (
                <div className="mt-4 ml-7">
                  <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                    {t('events.uploadCategory')}
                  </label>
                  <select
                    value={formData.upload_category_id || ''}
                    onChange={(e) => setFormData({
                      ...formData,
                      upload_category_id: e.target.value ? Number(e.target.value) : null
                    })}
                    className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg focus:ring-2 focus:ring-primary-500 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100"
                  >
                    <option value="">{t('events.selectCategory')}</option>
                    {categories.map(category => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                    {t('events.uploadCategoryHelp')}
                  </p>
                </div>
              )}
            </div>
          </div>
        </Card>

        {/* Feedback Settings */}
        <FeedbackSettings
          settings={formData.feedback_settings}
          onChange={(settings) => setFormData(prev => ({ ...prev, feedback_settings: settings }))}
        />

        {/* Form Actions */}
        <div className="flex items-center justify-end gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => navigate('/admin/events')}
          >
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            variant="primary"
            isLoading={createMutation.isPending}
            disabled={createMutation.isPending}
          >
            {t('events.createEvent')}
          </Button>
        </div>
      </form>
    </div>
  );
};
