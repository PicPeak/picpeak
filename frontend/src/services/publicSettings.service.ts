import { api } from '../config/api';

export interface PublicSettings {
  branding_company_name: string;
  branding_company_tagline: string;
  branding_support_email: string;
  branding_footer_text: string;
  branding_watermark_enabled: boolean;
  branding_watermark_logo_url: string;
  branding_watermark_position: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left' | 'center';
  branding_watermark_opacity: number;
  branding_watermark_size: number;
  branding_favicon_url: string;
  branding_logo_url: string;
  branding_logo_url_dark?: string;
  branding_logo_size?: string;
  branding_logo_max_height?: number;
  /**
   * Logo placement. 'left' | 'center' | 'right' = inside the gallery
   * header. 'sidepanel' = moved into the admin sidebar's brand row
   * (admin chrome only — gallery falls back to 'left').
   */
  branding_logo_position?: 'left' | 'center' | 'right' | 'sidepanel';
  branding_logo_display_mode?: 'logo_only' | 'text_only' | 'logo_and_text';
  branding_logo_display_header?: boolean;
  branding_logo_display_hero?: boolean;
  branding_hide_powered_by?: boolean;
  /**
   * Force the entire site into a specific color mode (instance-wide).
   * 'dark' or 'light' override user/system preference; null = no force.
   * AdminDarkModeContext + ThemeContext both honor this.
   */
  branding_force_color_mode?: 'dark' | 'light' | null;
  /**
   * Login-page-only branding (#354 follow-up). Applies exclusively to
   * /admin/login and /customer/login. Defaults: frame on, size 'medium'.
   */
  branding_login_logo_frame_enabled?: boolean;
  branding_login_logo_size?: 'small' | 'medium' | 'large' | 'xlarge';
  // Footer overhaul (#441 + #440). Empty strings mean "hide".
  branding_facebook_url?: string;
  branding_instagram_url?: string;
  branding_whatsapp_url?: string;
  branding_twitter_url?: string;
  branding_youtube_url?: string;
  branding_promo_markdown?: string;
  branding_promo_position?: 'above_footer' | 'below_footer';
  // Per-install promo banner alignment (#482). Defaults to 'center'
  // so the banner aligns with the gallery footer's centering.
  branding_promo_alignment?: 'left' | 'center' | 'right';
  theme_config: any;
  default_language: string;
  enable_analytics: boolean;
  general_date_format: string | { format: string; locale: string };
  /** '12h' or '24h' — controls how times are rendered in admin +
   *  customer views. Storage is always 24h; only display toggles. */
  general_time_format?: '12h' | '24h';
  /** Dashboard CRM-overview tile visibility. All default true; only
   *  explicit false hides the matching tile. */
  crm_overview_show_revenue?: boolean;
  crm_overview_show_outstanding?: boolean;
  crm_overview_show_quotes?: boolean;
  crm_overview_show_invoices?: boolean;
  enable_recaptcha: boolean;
  recaptcha_site_key: string | null;
  maintenance_mode: boolean;
  umami_enabled: boolean;
  umami_url: string | null;
  umami_website_id: string | null;
  umami_share_url: string | null;
  // Pluggable trackers (#663 Phase 1). The backend always surfaces these;
  // missing fields fall back via the existing umami_* shape so older
  // builds keep working.
  analytics_tracker_provider?: 'none' | 'umami' | 'rybbit' | 'custom';
  rybbit_url?: string | null;
  rybbit_website_id?: string | null;
  // Custom-mode HTML snippet, already sanitised server-side.
  analytics_custom_head_html?: string;
  // Upload settings
  allowed_file_types?: string;
  // #613 — per-batch file count limit, surfaced so the guest UserPhotoUpload
  // modal can render the real number in `upload.fileRequirements` and refuse
  // oversized batches client-side. Backend enforces the same value too.
  general_max_files_per_upload?: number;
  // Event field requirements
  event_require_customer_name?: boolean;
  event_require_customer_email?: boolean;
  event_require_admin_email?: boolean;
  event_require_event_date?: boolean;
  event_require_expiration?: boolean;
  event_default_require_password?: boolean;
  event_default_feedback_enabled?: boolean;
  gallery_show_filter_bar?: boolean;
  event_phone_field_enabled?: boolean;
  // SEO meta tags (consumed by RobotsMetaTags)
  seo_meta_noindex?: boolean;
  seo_meta_nofollow?: boolean;
  seo_meta_noai?: boolean;
}

export const publicSettingsService = {
  // Get public settings (no authentication required)
  async getPublicSettings(): Promise<PublicSettings> {
    const response = await api.get<PublicSettings>('/public/settings');
    return response.data;
  }
};