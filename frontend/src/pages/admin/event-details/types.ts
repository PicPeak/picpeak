export type EventDetailsTab = 'overview' | 'photos' | 'categories' | 'guests';

export type EditFormState = {
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

export const INITIAL_EDIT_FORM: EditFormState = {
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
};
