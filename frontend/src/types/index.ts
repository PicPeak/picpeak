// Event/Gallery types
export interface Event {
  id: number;
  slug: string;
  event_type: string;
  event_name: string;
  event_date: string | null;
  customer_name?: string;
  customer_email: string;
  customer_phone?: string | null;
  admin_email: string;
  welcome_message?: string;
  color_theme?: string;
  share_link: string;
  created_at: string;
  expires_at: string | null;
  is_active: boolean;
  is_archived: boolean;
  archive_path?: string;
  archived_at?: string;
  require_password?: boolean;
  photo_count?: number;
  total_size?: number;
  recent_photos?: Array<{
    filename: string;
    type: string;
    size_bytes: number;
    uploaded_at: string;
  }>;
  allow_user_uploads?: boolean;
  upload_category_id?: number | null;
  hero_photo_id?: number | null;
  total_views?: number;
  total_downloads?: number;
  unique_visitors?: number;
  source_mode?: 'managed' | 'reference' | string;
  external_path?: string | null;
  // Download protection fields
  allow_downloads?: boolean;
  protection_level?: 'basic' | 'standard' | 'enhanced' | 'maximum';
  disable_right_click?: boolean;
  watermark_downloads?: boolean;
  enable_devtools_protection?: boolean;
  use_canvas_rendering?: boolean;
  // Hero logo customization fields
  hero_logo_visible?: boolean | null;
  hero_logo_size?: 'small' | 'medium' | 'large' | 'xlarge' | null;
  hero_logo_position?: 'top' | 'center' | 'bottom';
  hero_logo_url?: string | null;
  // Per-event opt-in for using the hero photo as the social-share
  // preview image (#474). When false, og:image falls back to the
  // brand logo. Defaults false on existing rows so no admin's hero
  // photo gets surfaced via WhatsApp share until they consciously
  // flip it on.
  og_image_share_enabled?: boolean;
  // Header style settings (decoupled from layout)
  header_style?: 'hero' | 'standard' | 'minimal' | 'none';
  hero_divider_style?: 'wave' | 'straight' | 'angle' | 'curve' | 'none';
  // Hero image anchor position (#162) – keyword or "X% Y%" focal point
  hero_image_anchor?: string;
  // CSS Template
  css_template_id?: number | null;
  // Photo cap
  photo_cap?: number | null;
  // Draft mode
  is_draft?: boolean;
  // Client access (#172)
  client_access_enabled?: boolean;
  client_share_token?: string;
  // Live Slideshow / "Diashow" (migration 138). Token-only fullscreen kiosk
  // link minted on demand; null token = disabled. Settings drive the running
  // projector and can be changed live.
  show_share_token?: string | null;
  show_interval_ms?: number;
  show_transition?: 'crossfade' | 'cut' | 'slide' | 'kenburns' | 'dipwhite' | 'dipblack';
  show_transition_ms?: number;
  // Watermark MODE only (null=inherit global / true / false). The look lives
  // globally in Settings → Slideshow, not per event.
  show_watermark?: boolean | null;
  show_colorfilter?: 'none' | 'bw' | 'sepia' | 'warm' | 'cool' | 'vignette';
  // Default photo sort order
  default_photo_sort?: string;
  // Pre-event reminder override (migration 143)
  event_reminder_disabled?: boolean;
  event_reminder_offset_days?: number | null;
  event_reminder_body_override?: string | null;
  event_reminder_sent_at?: string | null;
}

export type GalleryAccessLevel = 'guest' | 'client';

export interface GalleryInfo {
  event_name: string;
  event_type: string;
  event_date: string | null;
  expires_at: string | null;
  is_active: boolean;
  is_expired: boolean;
  requires_password?: boolean;
  color_theme?: string;
  default_photo_sort?: string;
}

export interface Photo {
  id: number;
  filename: string;
  // Original camera filename (e.g. DSC_1234.jpg) — populated for uploads
  // post migration 062. Null for legacy rows. Surfaced in the lightbox
  // when the admin toggles `use_original_filenames` on (#508).
  original_filename?: string | null;
  url: string;
  thumbnail_url?: string;
  hero_url?: string; // Hero-optimized image URL (1920x1080) for full-width hero sections
  // Lightbox preview URL (#492). Set only when the admin has flipped
  // lightbox_preview_enabled in Settings → Thumbnails. Aspect-preserved
  // ≤1920px JPEG; the lightbox prefers it over `url` for image photos
  // and falls back to `url` when null (off, video, or not yet generated).
  preview_url?: string | null;
  secure_url_template?: string;
  download_url_template?: string;
  requires_token?: boolean;
  type: 'collage' | 'individual' | 'video';
  category_id?: number | string | null;
  category_name?: string;
  category_slug?: string;
  // Per-category download permission (#640). Defaults true for uncategorised
  // photos and for categories that pre-date migration 135. The frontend hides
  // the lightbox download button when this is false (event-level allow_downloads
  // also has to be true — they AND together).
  category_allow_downloads?: boolean;
  size: number;
  uploaded_at: string;
  captured_at?: string; // EXIF capture date (if available)
  // Media type fields
  media_type?: 'photo' | 'video' | 'image';
  mime_type?: string;
  duration?: number; // Duration in seconds for videos
  video_codec?: string;
  audio_codec?: string;
  width?: number;
  height?: number;
  // Visibility (#172)
  visibility?: 'visible' | 'hidden';
  // Feedback fields
  has_feedback?: boolean;
  average_rating?: number;
  total_ratings?: number;
  comment_count?: number;
  like_count?: number;
  // Per-viewer flag (#590 follow-up). True when the requesting viewer has
  // an active like row for this photo, false otherwise. Computed server-side
  // by gallery.js using the same identity model as galleryFeedback.js
  // (guest_id when a guest token is present, else IP+UA hash fallback).
  // Used to seed the lifted likedPhotoIds Set in grid layouts on mount.
  is_liked?: boolean;
  favorite_count?: number;
}

export interface PhotoCategory {
  id: number | string;
  name: string;
  slug: string;
  is_global: boolean;
  hero_photo_id?: number | null;
}

export interface GalleryData {
  event: {
    id: number;
    event_name: string;
    event_type: string;
    event_date: string | null;
    welcome_message?: string;
    color_theme?: string;
    expires_at: string | null;
    allow_user_uploads?: boolean;
    upload_category_id?: number | null;
    hero_photo_id?: number | null;
    allow_downloads?: boolean;
    disable_right_click?: boolean;
    watermark_downloads?: boolean;
    watermark_text?: string;
    require_password?: boolean;
    protection_level?: 'basic' | 'standard' | 'enhanced' | 'maximum';
    image_quality?: number;
    use_canvas_rendering?: boolean;
    enable_devtools_protection?: boolean;
    fragmentation_level?: number;
    overlay_protection?: boolean;
    // Hero logo customization fields
    hero_logo_visible?: boolean | null;
    hero_logo_size?: 'small' | 'medium' | 'large' | 'xlarge' | null;
    hero_logo_position?: 'top' | 'center' | 'bottom';
    hero_logo_url?: string | null;
    // Header style settings (decoupled from layout)
    header_style?: 'hero' | 'standard' | 'minimal' | 'none';
    hero_divider_style?: 'wave' | 'straight' | 'angle' | 'curve' | 'none';
    // Hero image anchor position (#162) – keyword or "X% Y%" focal point
    hero_image_anchor?: string;
    // Default photo sort order
    default_photo_sort?: string;
    // Mirror of admin's `general_use_original_filenames_for_downloads`.
    // When true, the lightbox surfaces each photo's `original_filename`
    // alongside the position counter (#508).
    use_original_filenames?: boolean;
  };
  categories?: PhotoCategory[];
  photos: Photo[];
}

export interface GalleryStats {
  total_photos: number;
  total_views: number;
  total_downloads: number;
  unique_visitors: number;
}

export interface ResolvedGalleryIdentifier {
  slug: string;
  token: string;
  matchType: string;
  share_link: string;
  share_path: string;
  share_url: string;
  short_enabled: boolean;
  requires_password: boolean;
}

// Auth types
export interface AdminUser {
  id: number;
  username: string;
  email: string;
  mustChangePassword?: boolean;
  role?: {
    name: string;
    displayName: string;
  };
  roleId?: number;
  roleName?: string;
  roleDisplayName?: string;
  isActive?: boolean;
  lastLogin?: string | null;
  lastLoginIp?: string | null;
  createdAt?: string;
  updatedAt?: string;
  createdByUsername?: string;
}

export interface LoginResponse {
  token: string;
  user: AdminUser;
}

// Two-step admin login: when MFA is enabled, POST /auth/admin/login returns
// this challenge instead of a session (no cookie yet). The mfaToken is a
// short-lived (5 min) JWT exchanged at POST /auth/admin/login/mfa.
export interface MfaChallengeResponse {
  mfaRequired: true;
  mfaToken: string;
}

export type AdminLoginResponse = LoginResponse | MfaChallengeResponse;

export function isMfaChallenge(res: AdminLoginResponse): res is MfaChallengeResponse {
  return (res as MfaChallengeResponse).mfaRequired === true;
}

export interface GalleryAuthResponse {
  token: string;
  event: {
    id: number;
    event_name: string;
    event_type: string;
    event_date: string;
    welcome_message?: string;
    color_theme?: string;
    expires_at: string;
    allow_user_uploads?: boolean;
    upload_category_id?: number | null;
    require_password?: boolean;
    photo_cap?: number | null;
  };
  accessLevel?: GalleryAccessLevel;
}

// API Error type
export interface ApiError {
  error: string;
  errors?: Array<{
    type: string;
    msg: string;
    path: string;
    location: string;
  }>;
}

// Role and Permission types
export interface AdminRole {
  id: number;
  name: string;
  displayName: string;
  description?: string;
  isSystem?: boolean;
  priority?: number;
}

export interface AdminPermissions {
  role: {
    name: string;
    displayName: string;
  } | null;
  permissions: string[];
}

export interface AdminInvitation {
  id: number;
  email: string;
  roleName: string;
  invitedBy: string;
  expiresAt: string;
  createdAt: string;
}

// Export protection types
export * from './protection';
