const express = require('express');
const { db, withRetry } = require('../database/db');
const router = express.Router();

// Get public settings (branding and theme)
router.get('/', async (req, res) => {
  try {
    // Fetch branding, theme, general, security, analytics, and event settings
    // Note: We include analytics in the query but it might not exist yet
    const settings = await withRetry(async () => {
      return await db('app_settings')
        .where(function() {
          this.whereIn('setting_type', ['branding', 'theme', 'general', 'security', 'analytics', 'boolean'])
            .orWhere('setting_key', 'like', 'analytics_%')
            .orWhere('setting_key', 'like', 'event_require_%')
            .orWhereIn('setting_key', [
              'seo_meta_noindex', 'seo_meta_nofollow', 'seo_meta_noai',
              'event_default_require_password',
              'event_default_feedback_enabled',
              'gallery_show_filter_bar',
              'event_phone_field_enabled',
              // #613 — guest upload UI needs to know the per-batch file
              // count limit so it can render a real number in the
              // "fileRequirements" hint (`{{limit}}` was showing literal)
              // and short-circuit before posting too many files. The
              // backend route also enforces it via getMaxFilesPerUpload,
              // but a client-side guard saves a 4MB+ round-trip when the
              // limit is small.
              'general_max_files_per_upload'
            ]);
        })
        .select('setting_key', 'setting_value');
    });
    
    // Convert to object format
    const settingsObject = {};
    settings.forEach(setting => {
      // Handle null/undefined values
      if (setting.setting_value === null || setting.setting_value === undefined) {
        settingsObject[setting.setting_key] = null;
        return;
      }
      // If value is already a primitive (boolean, number), use it directly
      if (typeof setting.setting_value === 'boolean' || typeof setting.setting_value === 'number') {
        settingsObject[setting.setting_key] = setting.setting_value;
        return;
      }
      // Try to parse string values as JSON
      try {
        settingsObject[setting.setting_key] = JSON.parse(setting.setting_value);
      } catch (e) {
        // If parsing fails, use the raw value
        settingsObject[setting.setting_key] = setting.setting_value;
      }
    });

    // Return only safe public settings
    const publicSettings = {
      branding_company_name: settingsObject.branding_company_name || '',
      branding_company_tagline: settingsObject.branding_company_tagline || '',
      branding_support_email: settingsObject.branding_support_email || '',
      branding_footer_text: settingsObject.branding_footer_text || '',
      branding_watermark_enabled: settingsObject.branding_watermark_enabled || false,
      branding_watermark_logo_url: settingsObject.branding_watermark_logo_url || '',
      branding_watermark_position: settingsObject.branding_watermark_position || 'bottom-right',
      branding_watermark_opacity: settingsObject.branding_watermark_opacity || 50,
      branding_watermark_size: settingsObject.branding_watermark_size || 15,
      branding_favicon_url: settingsObject.branding_favicon_url || '',
      branding_logo_url: settingsObject.branding_logo_url || '',
      branding_logo_url_dark: settingsObject.branding_logo_url_dark || '',
      branding_logo_size: settingsObject.branding_logo_size || 'medium',
      branding_logo_max_height: settingsObject.branding_logo_max_height || 48,
      branding_logo_position: settingsObject.branding_logo_position || 'left',
      branding_logo_display_header: settingsObject.branding_logo_display_header !== false,
      branding_logo_display_hero: settingsObject.branding_logo_display_hero !== false,
      branding_logo_display_mode: settingsObject.branding_logo_display_mode || 'logo_and_text',
      branding_hide_powered_by: settingsObject.branding_hide_powered_by === true,
      // Footer overhaul (#441 + #440). Empty strings hide each social
      // icon individually; promo_markdown empty hides the slot for
      // events in 'inherit' mode.
      branding_facebook_url: settingsObject.branding_facebook_url || '',
      branding_instagram_url: settingsObject.branding_instagram_url || '',
      branding_whatsapp_url: settingsObject.branding_whatsapp_url || '',
      branding_twitter_url: settingsObject.branding_twitter_url || '',
      branding_youtube_url: settingsObject.branding_youtube_url || '',
      branding_promo_markdown: settingsObject.branding_promo_markdown || '',
      branding_promo_position: settingsObject.branding_promo_position === 'below_footer'
        ? 'below_footer'
        : 'above_footer',
      // Promo content alignment (#482). Defaults to center so the
      // banner aligns with the gallery footer; admin can flip to
      // left or right via Settings → Branding.
      branding_promo_alignment: ['left', 'center', 'right'].includes(settingsObject.branding_promo_alignment)
        ? settingsObject.branding_promo_alignment
        : 'center',
      // Force a specific color mode site-wide. When set, the user toggle
      // is hidden and the value overrides per-theme/system preference.
      // Allowed values: 'dark' | 'light' | null (null = no force).
      branding_force_color_mode: settingsObject.branding_force_color_mode === 'dark'
        ? 'dark'
        : settingsObject.branding_force_color_mode === 'light'
          ? 'light'
          : null,
      // Login-page-only branding (#354 follow-up). Applies exclusively
      // to /admin/login and /customer/login — the rest of the app keeps
      // using branding_logo_size / branding_logo_max_height. Default
      // true / 'medium' preserves the visual state shipped before the
      // toggles existed.
      branding_login_logo_frame_enabled: settingsObject.branding_login_logo_frame_enabled !== false,
      branding_login_logo_size: ['small', 'medium', 'large', 'xlarge'].includes(settingsObject.branding_login_logo_size)
        ? settingsObject.branding_login_logo_size
        : 'medium',
      theme_config: settingsObject.theme_config || null,
      default_language: settingsObject.general_default_language || 'en',
      enable_analytics: settingsObject.general_enable_analytics !== false,
      general_date_format: settingsObject.general_date_format || 'PPP',
      // '12h' / '24h' — controls how times are rendered in admin +
      // customer views via the useLocalizedDate hook. The underlying
      // storage is always HH:mm (24h); only the displayed form toggles.
      // Default '24h' to match the operator's CH/DE locale.
      general_time_format: settingsObject.general_time_format === '12h' ? '12h' : '24h',
      // CRM overview tile visibility (admin-only — these are surfaced
      // via the public-settings endpoint because the dashboard reads
      // them on mount and the value never depends on auth state. All
      // four default ON; only explicit false hides the tile.
      crm_overview_show_revenue: settingsObject.crm_overview_show_revenue !== false,
      crm_overview_show_outstanding: settingsObject.crm_overview_show_outstanding !== false,
      crm_overview_show_quotes: settingsObject.crm_overview_show_quotes !== false,
      crm_overview_show_invoices: settingsObject.crm_overview_show_invoices !== false,
      enable_recaptcha: settingsObject.security_enable_recaptcha === true || settingsObject.security_enable_recaptcha === 'true',
      recaptcha_site_key: settingsObject.security_recaptcha_site_key || null,
      maintenance_mode: settingsObject.general_maintenance_mode === true || settingsObject.general_maintenance_mode === 'true',
      // Umami analytics configuration (only if enabled). Kept for
      // back-compat: pre-#663 installs without `analytics_tracker_provider`
      // still surface Umami settings under their original keys so the
      // frontend tracker script switches over cleanly.
      umami_enabled: settingsObject.analytics_umami_enabled === true || settingsObject.analytics_umami_enabled === 'true',
      umami_url: (settingsObject.analytics_umami_enabled === true || settingsObject.analytics_umami_enabled === 'true') ? (settingsObject.analytics_umami_url || null) : null,
      umami_website_id: (settingsObject.analytics_umami_enabled === true || settingsObject.analytics_umami_enabled === 'true') ? (settingsObject.analytics_umami_website_id || null) : null,
      umami_share_url: (settingsObject.analytics_umami_enabled === true || settingsObject.analytics_umami_enabled === 'true') ? (settingsObject.analytics_umami_share_url || null) : null,
      // Tracker-provider switch (#663 Phase 1). Drives which provider's
      // script gets injected into the gallery <head>. 'none' / unset =
      // no tracker. The frontend tracker service picks the right shape
      // from the (provider, *_url, *_website_id) tuple below.
      analytics_tracker_provider: (() => {
        const explicit = settingsObject.analytics_tracker_provider;
        if (typeof explicit === 'string' && ['none', 'umami', 'rybbit', 'custom'].includes(explicit)) {
          return explicit;
        }
        // Back-compat with installs that haven't picked yet.
        return (settingsObject.analytics_umami_enabled === true || settingsObject.analytics_umami_enabled === 'true')
          ? 'umami'
          : 'none';
      })(),
      // Rybbit native provider (#663). Only exposed when actively chosen
      // — otherwise hidden so the front-end never tries to inject a
      // stale tracker.
      rybbit_url: settingsObject.analytics_tracker_provider === 'rybbit'
        ? (settingsObject.analytics_rybbit_url || null)
        : null,
      rybbit_website_id: settingsObject.analytics_tracker_provider === 'rybbit'
        ? (settingsObject.analytics_rybbit_website_id || null)
        : null,
      // Custom-mode pre-sanitised HTML snippet (#663). Sanitised at save
      // time via customScriptSanitiser; surfaced as-is here so the
      // gallery <head> can render it without re-sanitising on every
      // request.
      analytics_custom_head_html: settingsObject.analytics_tracker_provider === 'custom'
        ? (settingsObject.analytics_custom_head_html || '')
        : '',
      // Event field requirements
      event_require_customer_name: settingsObject.event_require_customer_name !== false,
      event_require_customer_email: settingsObject.event_require_customer_email !== false,
      event_require_admin_email: settingsObject.event_require_admin_email !== false,
      event_require_event_date: settingsObject.event_require_event_date !== false,
      event_require_expiration: settingsObject.event_require_expiration !== false,
      // Default value for "Require password" toggle in event creation form
      event_default_require_password: settingsObject.event_default_require_password !== false,
      // Default value for the "Guest Feedback enabled" toggle (#520).
      // Defaults to false (matches the prior hard-coded form default), so
      // existing installs see no behaviour change until an admin flips it.
      event_default_feedback_enabled: settingsObject.event_default_feedback_enabled === true,
      // Phone-number field on events is opt-in (#322).
      event_phone_field_enabled: settingsObject.event_phone_field_enabled === true,
      // Whether to show the search/sort filter bar in public galleries (default: true)
      gallery_show_filter_bar: settingsObject.gallery_show_filter_bar !== false,
      // Upload settings (safe to expose - needed for client-side validation)
      allowed_file_types: settingsObject.general_allowed_file_types || 'jpg,jpeg,png,webp',
      // #613 — per-batch file count limit. The guest UserPhotoUpload modal
      // reads this both to render the "{{limit}} files per upload" hint
      // (showed `{{limit}}` literal before this) and to refuse a batch
      // before posting it. Backend route enforces the same value via
      // getMaxFilesPerUpload(), so the client-side check is purely a UX
      // optimisation. Default mirrors uploadSettings.js
      // DEFAULT_MAX_FILES_PER_UPLOAD so the UI shows a sensible number
      // even on installs that have never explicitly set the value.
      general_max_files_per_upload: Number.isFinite(Number(settingsObject.general_max_files_per_upload))
        ? Number(settingsObject.general_max_files_per_upload)
        : 500,
      // SEO meta tag flags (safe to expose - these are intended for crawlers)
      seo_meta_noindex: settingsObject.seo_meta_noindex === true,
      seo_meta_nofollow: settingsObject.seo_meta_nofollow === true,
      seo_meta_noai: settingsObject.seo_meta_noai === true
    };

    res.json(publicSettings);
  } catch (error) {
    console.error('Public settings fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

module.exports = router;