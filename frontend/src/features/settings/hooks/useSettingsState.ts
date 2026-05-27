import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { useTranslation } from 'react-i18next';
import { settingsService } from '../../../services/settings.service';
import { adminService } from '../../../services/admin.service';
import { useAdminAuth } from '../../../contexts';
import { toBoolean, toNumber } from '../../../utils/parsers';

const BYTES_PER_GB = 1024 * 1024 * 1024;
export const MAX_FILES_PER_UPLOAD_LIMIT = 2000;

export interface GeneralSettings {
  site_url: string;
  default_expiration_days: number;
  max_file_size_mb: number;
  max_files_per_upload: number;
  allowed_file_types: string;
  // #509 — re-added after the main-into-beta merge dropped it.
  max_upload_batch_size_mb: number;
  enable_analytics: boolean;
  enable_registration: boolean;
  maintenance_mode: boolean;
  short_gallery_urls: boolean;
  use_original_filenames_for_downloads: boolean;
  default_language: string;
  date_format: { format: string; locale: string };
}

export interface SecuritySettings {
  password_min_length: number;
  password_complexity: string;
  enable_2fa: boolean;
  session_timeout_minutes: number;
  max_login_attempts: number;
  attempt_window_minutes: number;
  lockout_duration_minutes: number;
  enable_recaptcha: boolean;
  recaptcha_site_key: string;
  recaptcha_secret_key: string;
}

export interface AnalyticsSettings {
  umami_enabled: boolean;
  umami_url: string;
  umami_website_id: string;
  umami_share_url: string;
}

export interface EventSettings {
  event_require_customer_name: boolean;
  event_require_customer_email: boolean;
  event_require_admin_email: boolean;
  event_require_event_date: boolean;
  event_require_expiration: boolean;
  event_default_require_password: boolean;
  event_default_feedback_enabled: boolean;
  gallery_show_filter_bar: boolean;
  event_phone_field_enabled: boolean;
}

export interface SeoSettings {
  allow_indexing: boolean;
  block_ai_crawlers: boolean;
  block_social_bots: boolean;
  blocked_ai_agents: string[];
  custom_rules: Array<{ userAgent: string; disallow: string[] }>;
  meta_noindex: boolean;
  meta_nofollow: boolean;
  meta_noai: boolean;
  sitemap_url: string;
}

export function useSettingsState() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const { updateUserProfile } = useAdminAuth();

  // Fetch settings
  const { data: settings, isLoading } = useQuery({
    queryKey: ['admin-settings'],
    queryFn: () => settingsService.getAllSettings(),
  });

  const { data: adminProfile, isLoading: adminProfileLoading } = useQuery({
    queryKey: ['admin-profile'],
    queryFn: () => adminService.getAdminProfile(),
  });

  // General settings state
  const [generalSettings, setGeneralSettings] = useState<GeneralSettings>({
    site_url: '',
    default_expiration_days: 30,
    max_file_size_mb: 50,
    max_files_per_upload: 500,
    allowed_file_types: 'jpg,jpeg,png,gif,webp',
    max_upload_batch_size_mb: 95,
    enable_analytics: true,
    enable_registration: false,
    maintenance_mode: false,
    short_gallery_urls: false,
    use_original_filenames_for_downloads: false,
    default_language: 'en',
    date_format: { format: 'dd/MM/yyyy', locale: 'en-GB' }
  });

  // Security settings state
  const [securitySettings, setSecuritySettings] = useState<SecuritySettings>({
    password_min_length: 8,
    password_complexity: 'moderate',
    enable_2fa: false,
    session_timeout_minutes: 60,
    max_login_attempts: 5,
    attempt_window_minutes: 15,
    lockout_duration_minutes: 30,
    enable_recaptcha: false,
    recaptcha_site_key: '',
    recaptcha_secret_key: ''
  });

  // Analytics settings state
  const [analyticsSettings, setAnalyticsSettings] = useState<AnalyticsSettings>({
    umami_enabled: false,
    umami_url: '',
    umami_website_id: '',
    umami_share_url: ''
  });

  // Event creation settings state
  const [eventSettings, setEventSettings] = useState<EventSettings>({
    event_require_customer_name: true,
    event_require_customer_email: true,
    event_require_admin_email: true,
    event_require_event_date: true,
    event_require_expiration: true,
    event_default_require_password: true,
    event_default_feedback_enabled: false,
    gallery_show_filter_bar: true,
    event_phone_field_enabled: false
  });

  // SEO settings state
  const [seoSettings, setSeoSettings] = useState<SeoSettings>({
    allow_indexing: false,
    block_ai_crawlers: true,
    block_social_bots: false,
    blocked_ai_agents: [],
    custom_rules: [],
    meta_noindex: true,
    meta_nofollow: false,
    meta_noai: true,
    sitemap_url: ''
  });

  // Account form state
  const [accountForm, setAccountForm] = useState({
    username: '',
    email: ''
  });
  const [accountErrors, setAccountErrors] = useState<Record<string, string>>({});

  // Storage state
  const [softLimitGb, setSoftLimitGb] = useState<number | ''>('');
  const [softLimitDirty, setSoftLimitDirty] = useState(false);
  const [capacityOverrideGb, setCapacityOverrideGb] = useState<number | ''>('');
  const [availableOverrideGb, setAvailableOverrideGb] = useState<number | ''>('');
  const [overrideDirty, setOverrideDirty] = useState(false);

  // Initialize settings from API
  useEffect(() => {
    if (settings) {
      setGeneralSettings({
        site_url: settings.general_site_url || '',
        default_expiration_days: toNumber(settings.general_default_expiration_days, 30),
        max_file_size_mb: toNumber(settings.general_max_file_size_mb, 50),
        max_files_per_upload: Math.min(
          MAX_FILES_PER_UPLOAD_LIMIT,
          Math.max(1, toNumber(settings.general_max_files_per_upload, 500))
        ),
        allowed_file_types: settings.general_allowed_file_types || 'jpg,jpeg,png,gif,webp',
        max_upload_batch_size_mb: toNumber(settings.general_max_upload_batch_size_mb, 95),
        enable_analytics: toBoolean(settings.general_enable_analytics, true),
        enable_registration: toBoolean(settings.general_enable_registration, false),
        maintenance_mode: toBoolean(settings.general_maintenance_mode, false),
        short_gallery_urls: toBoolean(settings.general_short_gallery_urls, false),
        use_original_filenames_for_downloads: toBoolean(
          settings.general_use_original_filenames_for_downloads,
          false
        ),
        default_language: settings.general_default_language || 'en',
        date_format: settings.general_date_format
          ? (typeof settings.general_date_format === 'string'
              ? { format: settings.general_date_format, locale: settings.general_date_format.includes('MM/dd') ? 'en-US' : 'en-GB' }
              : settings.general_date_format)
          : { format: 'dd/MM/yyyy', locale: 'en-GB' }
      });

      setSecuritySettings({
        password_min_length: toNumber(settings.security_password_min_length, 8),
        password_complexity: settings.security_password_complexity ?? 'moderate',
        enable_2fa: toBoolean(settings.security_enable_2fa, false),
        session_timeout_minutes: toNumber(settings.security_session_timeout_minutes, 60),
        max_login_attempts: toNumber(settings.security_max_login_attempts, 5),
        attempt_window_minutes: toNumber(settings.security_attempt_window_minutes, 15),
        lockout_duration_minutes: toNumber(settings.security_lockout_duration_minutes, 30),
        enable_recaptcha: toBoolean(settings.security_enable_recaptcha, false),
        recaptcha_site_key: settings.security_recaptcha_site_key ?? '',
        recaptcha_secret_key: settings.security_recaptcha_secret_key ?? ''
      });

      setAnalyticsSettings({
        umami_enabled: toBoolean(settings.analytics_umami_enabled, false),
        umami_url: settings.analytics_umami_url || '',
        umami_website_id: settings.analytics_umami_website_id || '',
        umami_share_url: settings.analytics_umami_share_url || ''
      });

      setEventSettings({
        event_require_customer_name: toBoolean(settings.event_require_customer_name, true),
        event_require_customer_email: toBoolean(settings.event_require_customer_email, true),
        event_require_admin_email: toBoolean(settings.event_require_admin_email, true),
        event_require_event_date: toBoolean(settings.event_require_event_date, true),
        event_require_expiration: toBoolean(settings.event_require_expiration, true),
        event_default_require_password: toBoolean(settings.event_default_require_password, true),
        event_default_feedback_enabled: toBoolean(settings.event_default_feedback_enabled, false),
        gallery_show_filter_bar: toBoolean(settings.gallery_show_filter_bar, true),
        event_phone_field_enabled: toBoolean(settings.event_phone_field_enabled, false)
      });

      setSeoSettings({
        allow_indexing: toBoolean(settings.seo_allow_indexing, false),
        block_ai_crawlers: toBoolean(settings.seo_block_ai_crawlers, true),
        block_social_bots: toBoolean(settings.seo_block_social_bots, false),
        blocked_ai_agents: Array.isArray(settings.seo_blocked_ai_agents) ? settings.seo_blocked_ai_agents : [],
        custom_rules: Array.isArray(settings.seo_custom_rules) ? settings.seo_custom_rules : [],
        meta_noindex: toBoolean(settings.seo_meta_noindex, true),
        meta_nofollow: toBoolean(settings.seo_meta_nofollow, false),
        meta_noai: toBoolean(settings.seo_meta_noai, true),
        sitemap_url: settings.seo_sitemap_url || ''
      });
    }
  }, [settings]);

  useEffect(() => {
    if (adminProfile) {
      setAccountForm({
        username: adminProfile.username || '',
        email: adminProfile.email || ''
      });
    }
  }, [adminProfile]);

  useEffect(() => {
    if (!settings || overrideDirty) return;

    const capacityOverrideBytes = settings.general_storage_capacity_override_bytes ?? null;
    const availableOverrideBytes = settings.general_storage_available_override_bytes ?? null;

    setCapacityOverrideGb(
      capacityOverrideBytes != null
        ? Number((capacityOverrideBytes / BYTES_PER_GB).toFixed(2))
        : ''
    );

    setAvailableOverrideGb(
      availableOverrideBytes != null
        ? Number((availableOverrideBytes / BYTES_PER_GB).toFixed(2))
        : ''
    );
  }, [settings, overrideDirty]);

  // Mutations
  const saveGeneralMutation = useMutation({
    mutationFn: async () => {
      const settingsData: Record<string, unknown> = {};
      Object.entries(generalSettings).forEach(([key, value]) => {
        settingsData[`general_${key}`] = value;
      });
      return settingsService.updateSettings(settingsData);
    },
    onSuccess: () => {
      toast.success(t('toast.settingsSaved'));
      queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
    },
    onError: () => {
      toast.error(t('toast.saveError'));
    }
  });

  const saveSecurityMutation = useMutation({
    mutationFn: async () => {
      const settingsData: Record<string, unknown> = {};
      Object.entries(securitySettings).forEach(([key, value]) => {
        settingsData[`security_${key}`] = value;
      });
      return settingsService.updateSettings(settingsData);
    },
    onSuccess: () => {
      toast.success(t('toast.settingsSaved'));
      queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
    },
    onError: () => {
      toast.error(t('toast.saveError'));
    }
  });

  const saveAnalyticsMutation = useMutation({
    mutationFn: async () => {
      const settingsData: Record<string, unknown> = {};
      Object.entries(analyticsSettings).forEach(([key, value]) => {
        settingsData[`analytics_${key}`] = value;
      });
      return settingsService.updateSettings(settingsData);
    },
    onSuccess: () => {
      toast.success(t('toast.settingsSaved'));
      queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
    },
    onError: () => {
      toast.error(t('toast.saveError'));
    }
  });

  const saveSeoMutation = useMutation({
    mutationFn: async () => {
      const settingsData: Record<string, unknown> = {};
      Object.entries(seoSettings).forEach(([key, value]) => {
        settingsData[`seo_${key}`] = value;
      });
      return settingsService.updateSettings(settingsData);
    },
    onSuccess: () => {
      toast.success(t('toast.settingsSaved'));
      queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
      queryClient.invalidateQueries({ queryKey: ['public-settings'] });
    },
    onError: () => {
      toast.error(t('toast.saveError'));
    }
  });

  const saveEventSettingsMutation = useMutation({
    mutationFn: async () => {
      const settingsData: Record<string, unknown> = {};
      Object.entries(eventSettings).forEach(([key, value]) => {
        settingsData[key] = value;
      });
      return settingsService.updateSettings(settingsData);
    },
    onSuccess: () => {
      toast.success(t('toast.settingsSaved'));
      queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
      queryClient.invalidateQueries({ queryKey: ['public-settings'] });
    },
    onError: () => {
      toast.error(t('toast.saveError'));
    }
  });

  const updateAdminProfileMutation = useMutation({
    mutationFn: (payload: { username: string; email: string }) => adminService.updateAdminProfile(payload),
    onSuccess: (updatedUser) => {
      toast.success(t('settings.general.accountSaveSuccess'));
      setAccountErrors({});
      setAccountForm({
        username: updatedUser.username,
        email: updatedUser.email
      });
      updateUserProfile(updatedUser);
      queryClient.invalidateQueries({ queryKey: ['admin-profile'] });
    },
    onError: (error: { response?: { data?: { errors?: Array<{ path: string; msg: string }>; error?: string } } }) => {
      if (error.response?.data?.errors) {
        const fieldErrors: Record<string, string> = {};
        for (const err of error.response.data.errors) {
          if (err.path === 'username') {
            fieldErrors.username = err.msg;
          }
          if (err.path === 'email') {
            fieldErrors.email = err.msg;
          }
        }
        setAccountErrors(fieldErrors);
        return;
      }

      if (error.response?.data?.error) {
        toast.error(error.response.data.error);
      } else {
        toast.error(t('toast.saveError'));
      }
    }
  });

  const saveSoftLimitMutation = useMutation({
    mutationFn: async (limitBytes: number | null) => {
      return settingsService.updateSettings({
        general_storage_soft_limit_bytes: limitBytes,
      });
    },
    onSuccess: () => {
      toast.success(t('toast.settingsSaved'));
      setSoftLimitDirty(false);
      queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
      queryClient.invalidateQueries({ queryKey: ['admin-storage-info'] });
      queryClient.invalidateQueries({ queryKey: ['storage-info'] });
    },
    onError: () => {
      toast.error(t('toast.saveError'));
    }
  });

  const saveCapacityOverrideMutation = useMutation({
    mutationFn: async (payload: { capacity: number | null; available: number | null }) => {
      return settingsService.updateSettings({
        general_storage_capacity_override_bytes: payload.capacity,
        general_storage_available_override_bytes: payload.available,
      });
    },
    onSuccess: () => {
      toast.success(t('toast.settingsSaved'));
      setOverrideDirty(false);
      queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
      queryClient.invalidateQueries({ queryKey: ['admin-storage-info'] });
      queryClient.invalidateQueries({ queryKey: ['storage-info'] });
    },
    onError: () => {
      toast.error(t('toast.saveError'));
    }
  });

  // Handlers
  const handleAccountChange = (field: 'username' | 'email') => (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    setAccountForm((prev) => ({ ...prev, [field]: value }));
    if (accountErrors[field]) {
      setAccountErrors((prev) => ({ ...prev, [field]: '' }));
    }
  };

  const handleAccountSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (updateAdminProfileMutation.isPending) return;

    const trimmedUsername = accountForm.username.trim();
    const trimmedEmail = accountForm.email.trim();
    const errors: Record<string, string> = {};

    if (!trimmedUsername) {
      errors.username = t('settings.general.accountUsernameRequired');
    } else if (trimmedUsername.length < 3) {
      errors.username = t('settings.general.accountUsernameLength');
    }

    if (!trimmedEmail) {
      errors.email = t('settings.general.accountEmailRequired');
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      errors.email = t('settings.general.accountEmailInvalid');
    }

    if (Object.keys(errors).length > 0) {
      setAccountErrors(errors);
      return;
    }

    updateAdminProfileMutation.mutate({
      username: trimmedUsername,
      email: trimmedEmail
    });
  };

  const handleSaveSoftLimit = () => {
    if (saveSoftLimitMutation.isPending) return;

    if (softLimitGb === '') {
      saveSoftLimitMutation.mutate(null);
      return;
    }

    const numericValue = Number(softLimitGb);

    if (!Number.isFinite(numericValue) || numericValue < 0) {
      toast.error(t('settings.storage.invalidSoftLimit'));
      return;
    }

    const limitBytes = Math.max(0, Math.round(numericValue * BYTES_PER_GB));
    saveSoftLimitMutation.mutate(limitBytes);
  };

  const handleSaveCapacityOverride = () => {
    if (saveCapacityOverrideMutation.isPending) return;

    if (capacityOverrideGb === '' && availableOverrideGb !== '') {
      toast.error(t('settings.storage.capacityRequiredForAvailable'));
      return;
    }

    const capacityValue = capacityOverrideGb === '' ? null : Number(capacityOverrideGb);
    const availableValue = availableOverrideGb === '' ? null : Number(availableOverrideGb);

    if ((capacityValue !== null && !Number.isFinite(capacityValue)) || (availableValue !== null && !Number.isFinite(availableValue))) {
      toast.error(t('settings.storage.invalidSoftLimit'));
      return;
    }

    if (capacityValue !== null && capacityValue < 0) {
      toast.error(t('settings.storage.invalidSoftLimit'));
      return;
    }

    if (availableValue !== null && availableValue < 0) {
      toast.error(t('settings.storage.invalidSoftLimit'));
      return;
    }

    const capacityBytes = capacityValue === null ? null : Math.max(0, Math.round(capacityValue * BYTES_PER_GB));
    const availableBytes = availableValue === null ? null : Math.max(0, Math.round(availableValue * BYTES_PER_GB));

    if (capacityBytes !== null && availableBytes !== null && availableBytes > capacityBytes) {
      toast.error(t('settings.storage.availableExceedsCapacity'));
      return;
    }

    saveCapacityOverrideMutation.mutate({ capacity: capacityBytes, available: availableBytes });
  };

  return {
    // Loading states
    isLoading,
    adminProfileLoading,

    // Settings data
    settings,
    generalSettings,
    setGeneralSettings,
    securitySettings,
    setSecuritySettings,
    analyticsSettings,
    setAnalyticsSettings,
    eventSettings,
    setEventSettings,
    seoSettings,
    setSeoSettings,

    // Account form
    accountForm,
    accountErrors,
    handleAccountChange,
    handleAccountSubmit,
    updateAdminProfileMutation,

    // Storage settings
    softLimitGb,
    setSoftLimitGb,
    softLimitDirty,
    setSoftLimitDirty,
    capacityOverrideGb,
    setCapacityOverrideGb,
    availableOverrideGb,
    setAvailableOverrideGb,
    overrideDirty,
    setOverrideDirty,
    handleSaveSoftLimit,
    handleSaveCapacityOverride,
    saveSoftLimitMutation,
    saveCapacityOverrideMutation,

    // Save mutations
    saveGeneralMutation,
    saveSecurityMutation,
    saveAnalyticsMutation,
    saveEventSettingsMutation,
    saveSeoMutation,

    // Translation
    t,
  };
}
