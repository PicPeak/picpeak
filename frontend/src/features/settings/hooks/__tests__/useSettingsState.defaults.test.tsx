/**
 * Pins every settings group's defaults and load mapping: the state before the
 * settings arrive, the state an empty payload loads to (the same defaults),
 * and a full payload mapped field by field.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) };
});
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../../contexts', () => ({ useAdminAuth: () => ({ updateUserProfile: vi.fn() }) }));
let loadSettings: () => Promise<Record<string, unknown>> = async () => ({});
vi.mock('../../../../services/settings.service', () => ({
  settingsService: {
    getAllSettings: () => loadSettings(),
    updateSettings: vi.fn(async () => ({})),
  },
}));
vi.mock('../../../../services/admin.service', () => ({
  adminService: { getAdminProfile: async () => ({}) },
}));

import { useSettingsState } from '../useSettingsState';

// The masked value GET /admin/settings returns for a stored key.
const MASKED = '\u2022'.repeat(8);

const DEFAULTS = {
  generalSettings: {
    site_url: '',
    site_url_env_pinned: false,
    site_url_stored: '',
    default_expiration_days: 30,
    max_file_size_mb: 50,
    max_video_size_mb: 500,
    video_web_rendition: false,
    video_strip_metadata: true,
    video_adaptive_streaming: false,
    max_files_per_upload: 500,
    photo_trash_retention_days: 30,
    allowed_file_types: 'jpg,jpeg,png,gif,webp',
    max_upload_batch_size_mb: 95,
    enable_analytics: true,
    enable_registration: false,
    maintenance_mode: false,
    short_gallery_urls: false,
    event_codes_enabled: false,
    root_event_code_page: false,
    use_original_filenames_for_downloads: false,
    default_language: 'en',
    date_format: { format: 'dd/MM/yyyy', locale: 'en-GB' },
    time_format: '24h',
  },
  securitySettings: {
    password_min_length: 8,
    password_complexity: 'moderate',
    session_timeout_minutes: 60,
    max_login_attempts: 5,
    attempt_window_minutes: 15,
    lockout_duration_minutes: 30,
    enable_recaptcha: false,
    recaptcha_site_key: '',
    recaptcha_secret_key: '',
    gallery_password_recoverable: false,
  },
  rateLimitSettings: {
    rate_limit_enabled: true,
    rate_limit_window_minutes: 15,
    rate_limit_max_requests: 300,
    rate_limit_auth_max_requests: 5,
    rate_limit_skip_authenticated: true,
    rate_limit_public_endpoints_only: false,
  },
  analyticsSettings: {
    tracker_provider: 'none',
    honor_do_not_track: true,
    umami_enabled: false,
    umami_url: '',
    umami_website_id: '',
    umami_share_url: '',
    umami_api_key: '',
    rybbit_url: '',
    rybbit_website_id: '',
    rybbit_api_key: '',
    custom_head_html: '',
  },
  eventSettings: {
    event_require_customer_name: true,
    event_require_customer_email: true,
    event_require_admin_email: true,
    event_require_event_date: true,
    event_require_expiration: true,
    event_default_require_password: true,
    event_default_feedback_enabled: false,
    event_default_allow_ratings: true,
    event_default_allow_likes: true,
    event_default_allow_favorites: true,
    event_default_allow_comments: true,
    event_default_allow_reactions: true,
    event_default_allow_color_labels: false,
    event_default_allow_decisions: false,
    event_default_allow_favorite_lists: false,
    event_default_keybind_mode: 'colors',
    event_default_download_limit: 0,
    event_default_guest_name_mode: 'off',
    event_default_show_credits_to_guests: false,
    event_default_walkthrough_enabled: false,
    event_default_folder_structure: true,
    event_default_delivery_days: 7,
    first_look_keyword_detection: true,
    first_look_folder_keywords: ['FirstLook', 'Sneak Peek'],
    gallery_show_filter_bar: true,
    gallery_lightbox_max_zoom_percent: 100,
    event_phone_field_enabled: false,
  },
  seoSettings: {
    allow_indexing: false,
    block_ai_crawlers: true,
    block_social_bots: false,
    blocked_ai_agents: [],
    custom_rules: [],
    meta_noindex: true,
    meta_nofollow: false,
    meta_noai: true,
    sitemap_url: '',
  },
};

// Every stored key set away from its default, mostly in the string form the
// settings route returns.
const FULL_PAYLOAD: Record<string, unknown> = {
  general_site_url: 'https://stored.example',
  general_site_url_env_pinned: true,
  general_site_url_effective: 'https://env.example',
  general_default_expiration_days: '14',
  general_max_file_size_mb: 80,
  general_max_video_size_mb: '900',
  general_video_web_rendition: 'true',
  general_video_strip_metadata: false,
  general_video_adaptive_streaming: '1',
  general_max_files_per_upload: 5000,
  general_photo_trash_retention_days: -4,
  general_allowed_file_types: 'jpg,png',
  general_max_upload_batch_size_mb: '50',
  general_enable_analytics: 'false',
  general_enable_registration: true,
  general_maintenance_mode: 'on',
  general_short_gallery_urls: true,
  general_event_codes_enabled: true,
  general_root_event_code_page: 'yes',
  general_use_original_filenames_for_downloads: true,
  general_default_language: 'de',
  general_date_format: 'MM/dd/yyyy',
  general_time_format: '12h',
  security_password_min_length: '12',
  security_password_complexity: 'strong',
  security_session_timeout_minutes: 120,
  security_max_login_attempts: '3',
  security_attempt_window_minutes: 10,
  security_lockout_duration_minutes: '45',
  security_enable_recaptcha: true,
  security_recaptcha_site_key: 'site-key',
  security_recaptcha_secret_key: 'secret',
  security_gallery_password_recoverable: 'true',
  rate_limit_enabled: false,
  rate_limit_window_minutes: '20',
  rate_limit_max_requests: 500,
  rate_limit_auth_max_requests: '9',
  rate_limit_skip_authenticated: 'false',
  rate_limit_public_endpoints_only: true,
  analytics_tracker_provider: 'rybbit',
  analytics_honor_do_not_track: false,
  analytics_umami_enabled: 'true',
  analytics_umami_url: 'https://umami.example',
  analytics_umami_website_id: 'u-1',
  analytics_umami_share_url: 'https://umami.example/share',
  analytics_umami_api_key: MASKED,
  analytics_rybbit_url: 'https://rybbit.example',
  analytics_rybbit_website_id: 'r-1',
  analytics_rybbit_api_key: 'rk',
  analytics_custom_head_html: '<!-- legacy -->',
  event_require_customer_name: false,
  event_require_customer_email: 'false',
  event_require_admin_email: false,
  event_require_event_date: '0',
  event_require_expiration: false,
  event_default_require_password: false,
  event_default_feedback_enabled: true,
  event_default_allow_ratings: false,
  event_default_allow_likes: 'false',
  event_default_allow_favorites: false,
  event_default_allow_comments: false,
  event_default_allow_reactions: false,
  event_default_allow_color_labels: true,
  event_default_allow_decisions: 'true',
  event_default_allow_favorite_lists: true,
  event_default_keybind_mode: 'lightroom',
  event_default_download_limit: '25',
  event_default_guest_name_mode: 'required',
  event_default_show_credits_to_guests: true,
  event_default_walkthrough_enabled: true,
  event_default_folder_structure: false,
  event_default_delivery_days: '10',
  first_look_keyword_detection: false,
  first_look_folder_keywords: ['Preview', 3],
  gallery_show_filter_bar: false,
  gallery_lightbox_max_zoom_percent: '400',
  event_phone_field_enabled: true,
  seo_allow_indexing: true,
  seo_block_ai_crawlers: false,
  seo_block_social_bots: true,
  seo_blocked_ai_agents: ['GPTBot'],
  seo_custom_rules: [{ userAgent: '*', disallow: ['/x'] }],
  seo_meta_noindex: false,
  seo_meta_nofollow: true,
  seo_meta_noai: false,
  seo_sitemap_url: 'https://stored.example/sitemap.xml',
};

const FULL_EXPECTED = {
  generalSettings: {
    site_url: 'https://env.example',
    site_url_env_pinned: true,
    site_url_stored: 'https://stored.example',
    default_expiration_days: 14,
    max_file_size_mb: 80,
    max_video_size_mb: 900,
    video_web_rendition: true,
    video_strip_metadata: false,
    video_adaptive_streaming: true,
    max_files_per_upload: 2000,
    photo_trash_retention_days: 0,
    allowed_file_types: 'jpg,png',
    max_upload_batch_size_mb: 50,
    enable_analytics: false,
    enable_registration: true,
    maintenance_mode: true,
    short_gallery_urls: true,
    event_codes_enabled: true,
    root_event_code_page: true,
    use_original_filenames_for_downloads: true,
    default_language: 'de',
    date_format: { format: 'MM/dd/yyyy', locale: 'en-US' },
    time_format: '12h',
  },
  securitySettings: {
    password_min_length: 12,
    password_complexity: 'strong',
    session_timeout_minutes: 120,
    max_login_attempts: 3,
    attempt_window_minutes: 10,
    lockout_duration_minutes: 45,
    enable_recaptcha: true,
    recaptcha_site_key: 'site-key',
    recaptcha_secret_key: 'secret',
    gallery_password_recoverable: true,
  },
  rateLimitSettings: {
    rate_limit_enabled: false,
    rate_limit_window_minutes: 20,
    rate_limit_max_requests: 500,
    rate_limit_auth_max_requests: 9,
    rate_limit_skip_authenticated: false,
    rate_limit_public_endpoints_only: true,
  },
  analyticsSettings: {
    tracker_provider: 'rybbit',
    honor_do_not_track: false,
    umami_enabled: true,
    umami_url: 'https://umami.example',
    umami_website_id: 'u-1',
    umami_share_url: 'https://umami.example/share',
    umami_api_key: MASKED,
    rybbit_url: 'https://rybbit.example',
    rybbit_website_id: 'r-1',
    rybbit_api_key: 'rk',
    custom_head_html: '<!-- legacy -->',
  },
  eventSettings: {
    event_require_customer_name: false,
    event_require_customer_email: false,
    event_require_admin_email: false,
    event_require_event_date: false,
    event_require_expiration: false,
    event_default_require_password: false,
    event_default_feedback_enabled: true,
    event_default_allow_ratings: false,
    event_default_allow_likes: false,
    event_default_allow_favorites: false,
    event_default_allow_comments: false,
    event_default_allow_reactions: false,
    event_default_allow_color_labels: true,
    event_default_allow_decisions: true,
    event_default_allow_favorite_lists: true,
    event_default_keybind_mode: 'lightroom',
    event_default_download_limit: 25,
    event_default_guest_name_mode: 'required',
    event_default_show_credits_to_guests: true,
    event_default_walkthrough_enabled: true,
    event_default_folder_structure: false,
    event_default_delivery_days: 10,
    first_look_keyword_detection: false,
    first_look_folder_keywords: ['Preview', '3'],
    gallery_show_filter_bar: false,
    gallery_lightbox_max_zoom_percent: 400,
    event_phone_field_enabled: true,
  },
  seoSettings: {
    allow_indexing: true,
    block_ai_crawlers: false,
    block_social_bots: true,
    blocked_ai_agents: ['GPTBot'],
    custom_rules: [{ userAgent: '*', disallow: ['/x'] }],
    meta_noindex: false,
    meta_nofollow: true,
    meta_noai: false,
    sitemap_url: 'https://stored.example/sitemap.xml',
  },
};

const groups = (state: ReturnType<typeof useSettingsState>) => ({
  generalSettings: state.generalSettings,
  securitySettings: state.securitySettings,
  rateLimitSettings: state.rateLimitSettings,
  analyticsSettings: state.analyticsSettings,
  eventSettings: state.eventSettings,
  seoSettings: state.seoSettings,
});

const render = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderHook(() => useSettingsState(), {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
};

describe('useSettingsState defaults', () => {
  it('starts every group at its defaults before the settings arrive', () => {
    loadSettings = () => new Promise(() => {});
    const { result } = render();
    expect(groups(result.current)).toEqual(DEFAULTS);
    expect(result.current.generalDirty).toBe(false);
  });

  it('loads an empty settings payload to the same defaults, not dirty', async () => {
    loadSettings = async () => ({});
    const { result } = render();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await waitFor(() => expect(groups(result.current)).toEqual(DEFAULTS));
    expect([result.current.generalDirty, result.current.securityDirty, result.current.analyticsDirty,
      result.current.eventDirty, result.current.seoDirty]).toEqual([false, false, false, false, false]);
  });

  it('maps a full settings payload field by field', async () => {
    loadSettings = async () => ({ ...FULL_PAYLOAD });
    const { result } = render();
    await waitFor(() => expect(result.current.securitySettings.password_min_length).toBe(12));
    expect(groups(result.current)).toEqual(FULL_EXPECTED);
    expect([result.current.generalDirty, result.current.securityDirty, result.current.analyticsDirty,
      result.current.eventDirty, result.current.seoDirty]).toEqual([false, false, false, false, false]);
  });

  it('keeps the legacy analytics_umami_enabled fallback when no provider is stored', async () => {
    loadSettings = async () => ({ analytics_umami_enabled: 'true' });
    const { result } = render();
    await waitFor(() => expect(result.current.analyticsSettings.tracker_provider).toBe('umami'));
    expect(result.current.analyticsSettings.umami_enabled).toBe(true);
  });

  it('keeps a stored object date format and the stored site URL when not env-pinned', async () => {
    loadSettings = async () => ({
      general_site_url: 'https://stored.example',
      general_site_url_effective: 'https://env.example',
      general_date_format: { format: 'yyyy-MM-dd', locale: 'sv-SE' },
      general_max_files_per_upload: 0,
    });
    const { result } = render();
    await waitFor(() => expect(result.current.generalSettings.site_url).toBe('https://stored.example'));
    expect(result.current.generalSettings.date_format).toEqual({ format: 'yyyy-MM-dd', locale: 'sv-SE' });
    expect(result.current.generalSettings.max_files_per_upload).toBe(1);
    expect(result.current.generalSettings.site_url_env_pinned).toBe(false);
  });
});
