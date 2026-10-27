import type { GuestNameMode } from '../../../types';

// 'guests' is "Guests & Feedback". Categories live in the Photos tab; an old
// ?tab=categories link opens Photos with the categories panel. 'orders' is
// the photo-sales purchase overview for priced galleries.
export type EventDetailsTab = 'overview' | 'photos' | 'guests' | 'orders' | 'settings';

export type EditFormState = {
  welcome_message: string;
  color_theme: string;
  css_template_id: number | null;
  expires_at: string;
  allow_user_uploads: boolean;
  // Reveal mode (#838): reveal_at is a datetime-local input string ('' = none)
  reveal_mode: boolean;
  reveal_at: string;
  upload_category_id: number | null;
  // Longest edge guest photos are scaled to (issue 1733); '' = originals.
  guest_upload_max_edge: string;
  // Uploader names (#1561)
  guest_name_mode: GuestNameMode;
  show_credits_to_guests: boolean;
  // Live refresh of an open gallery (issue 1733, C5)
  live_refresh: boolean;
  // Camera details in the guest lightbox (issue 1733, D1)
  show_exif_to_guests: boolean;
  // Neutral photo labels for guests (issue 1733, E6)
  neutral_photo_labels: boolean;
  hero_photo_id: number | null;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  source_mode: 'managed' | 'reference';
  external_path: string;
  external_watch: boolean;
  require_password: boolean;
  new_password: string;
  confirm_new_password: string;
  // Download protection settings
  protection_level: 'basic' | 'standard' | 'enhanced' | 'maximum';
  disable_right_click: boolean;
  allow_downloads: boolean;
  watermark_downloads: boolean;
  // '' = the company name from Branding.
  watermark_text: string;
  enable_devtools_protection: boolean;
  use_canvas_rendering: boolean;
  // Hero logo settings. null = inherit the global branding toggle (#756).
  hero_logo_visible: boolean | null;
  hero_logo_size: 'small' | 'medium' | 'large' | 'xlarge' | null;
  hero_logo_position: 'top' | 'center' | 'bottom';
  // #894: null = default (show); false hides the logo on the password page.
  login_logo_visible: boolean | null;
  // Hero image anchor position (#162) – keyword or "X% Y%" focal point
  hero_image_anchor: string;
  // Photo cap
  photo_cap: number;
  // Download limit (issue 1560). 0 = unlimited.
  download_limit: number;
  // Default photo sort
  default_photo_sort: string;
  // Videos ahead of photos in the guest gallery (issue 2263).
  videos_first: boolean;
  // Photo sales pricing for paid galleries.
  is_priced: boolean;
  free_photo_count: number;
  photo_price: number;
  purchase_access_days: number;
  // Per-event promotional override (#440). Three-way mode:
  //   inherit → use the global branding_promo_markdown
  //   custom  → render this event's promo_markdown
  //   off     → no promo for this event regardless of global
  promo_mode: 'inherit' | 'custom' | 'off';
  promo_markdown: string;
  // Info banner (#932) — same three-way mode, rendered above the grid.
  info_mode: 'inherit' | 'custom' | 'off';
  info_markdown: string;
  // Customer accounts assigned to this event (#354). Hydrated from
  // the GET /admin/events/:id response and sent back as a flat id
  // array on save.
  customer_accounts: Array<{ id: number; email: string; displayName: string | null }>;
  // Per-event opt-in for hero photo as social-share preview (#474).
  og_image_share_enabled: boolean;
};
