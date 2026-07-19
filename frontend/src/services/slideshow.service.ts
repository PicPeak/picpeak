import { api } from '../config/api';

export type SlideshowTransition = 'crossfade' | 'cut' | 'slide' | 'kenburns' | 'dipwhite' | 'dipblack';
export type SlideshowColorFilter = 'none' | 'bw' | 'sepia' | 'warm' | 'cool' | 'vignette';
// How each slide fills the screen: 'cover' = fill, crop to aspect; 'contain' =
// whole image with black bars (no crop — best for mixed portrait/landscape).
export type SlideshowFit = 'cover' | 'contain';
export const SLIDESHOW_FITS: SlideshowFit[] = ['cover', 'contain'];
// Which logo the watermark overlays. The first three are branding assets the
// admin uploads in Settings → Branding; 'event' is the event's own hero logo.
export type SlideshowWatermarkSource = 'logo' | 'logo_dark' | 'favicon' | 'event';
export type SlideshowWatermarkPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
// 'white' recolors the logo white (TV-ident look, for dark/transparent marks);
// 'original' keeps the logo's own colors (for boxed/colored badges).
export type SlideshowWatermarkStyle = 'white' | 'original';
export const SLIDESHOW_WATERMARK_STYLES: SlideshowWatermarkStyle[] = ['white', 'original'];
// Per-surface watermark choice. 'inherit' = follow the global default
// (admin Settings → Slideshow); 'on'/'off' = explicit override.
export type SlideshowWatermarkMode = 'inherit' | 'on' | 'off';
export const SLIDESHOW_WATERMARK_MODES: SlideshowWatermarkMode[] = ['inherit', 'on', 'off'];
// Play order (#202): 'chronological' = upload order; 'random' = client shuffle.
export type SlideshowOrder = 'chronological' | 'random';
export const SLIDESHOW_ORDERS: SlideshowOrder[] = ['chronological', 'random'];

export const SLIDESHOW_TRANSITIONS: SlideshowTransition[] = ['crossfade', 'cut', 'slide', 'kenburns', 'dipwhite', 'dipblack'];
export const SLIDESHOW_COLORFILTERS: SlideshowColorFilter[] = ['none', 'bw', 'sepia', 'warm', 'cool', 'vignette'];
export const SLIDESHOW_WATERMARK_SOURCES: SlideshowWatermarkSource[] = ['logo', 'logo_dark', 'favicon', 'event'];
export const SLIDESHOW_WATERMARK_POSITIONS: SlideshowWatermarkPosition[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

// Per-event editable style (the override). The picpeak-wide DEFAULT for these
// lives in the global Settings → Slideshow tab; new events inherit it and the
// per-event card maps these to `show_*` columns.
//
// NOTE: the watermark LOOK (logo/position/opacity/style/size) lives ONLY in the
// global tab — not duplicated here. Per-event carries just the `watermark` MODE
// (inherit/on/off), i.e. the override structure.
export interface SlideshowStyle {
  interval_ms: number;
  transition: SlideshowTransition;
  transition_ms: number;
  watermark: SlideshowWatermarkMode;
  // QR overlay mode (#837) — same tri-state semantics as the watermark.
  qr: SlideshowWatermarkMode;
  colorfilter: SlideshowColorFilter;
  // Play order + optional category filter (#202). category_id null = all photos.
  order: SlideshowOrder;
  category_id: number | null;
}

export const DEFAULT_SLIDESHOW_STYLE: SlideshowStyle = {
  interval_ms: 5000,
  transition: 'crossfade',
  transition_ms: 800,
  watermark: 'inherit',
  qr: 'inherit',
  colorfilter: 'none',
  order: 'chronological',
  category_id: null,
};

// Global slideshow defaults (admin Settings → Slideshow). The single source of
// truth for the watermark look; the per-event watermark mode 'inherit'/'on'
// renders with exactly these.
export interface SlideshowGlobalDefaults {
  // How slides fill the screen (fill+crop vs letterbox/black bars).
  slideshow_fit: SlideshowFit;
  // Picpeak-wide display preset (default style new events inherit).
  slideshow_interval_ms: number;
  slideshow_transition: SlideshowTransition;
  slideshow_transition_ms: number;
  slideshow_colorfilter: SlideshowColorFilter;
  slideshow_watermark_enabled: boolean;
  slideshow_watermark_source: SlideshowWatermarkSource;
  slideshow_watermark_position: SlideshowWatermarkPosition;
  slideshow_watermark_opacity: number;
  slideshow_watermark_style: SlideshowWatermarkStyle;
  // Logo size as a % of the viewport's shorter side.
  slideshow_watermark_size: number;
  // QR overlay defaults (#837) — same option shape as the watermark.
  slideshow_qr_enabled: boolean;
  slideshow_qr_position: SlideshowWatermarkPosition;
  slideshow_qr_opacity: number;
  slideshow_qr_size: number;
}

// Resolved watermark the kiosk renders (logo URL already resolved server-side).
export interface SlideshowWatermark {
  url: string;
  position: SlideshowWatermarkPosition;
  opacity: number;
  style: SlideshowWatermarkStyle;
  size: number;
}

// Resolved QR overlay (#837) — the share-link QR ships as a data URI, so the
// kiosk needs no QR library and no extra authenticated request.
export interface SlideshowQr {
  data_url: string;
  position: SlideshowWatermarkPosition;
  opacity: number;
  size: number;
}

export interface SlideshowSettings {
  interval_ms: number;
  transition: SlideshowTransition;
  transition_ms: number;
  colorfilter: SlideshowColorFilter;
  // Play order the kiosk applies (#202): 'random' shuffles client-side so
  // live-appended uploads keep working. The category filter is enforced
  // server-side, so it isn't echoed here.
  order: SlideshowOrder;
  fit: SlideshowFit;
  watermark: SlideshowWatermark | null;
  qr: SlideshowQr | null;
}

export interface SlideshowSession {
  token: string;
  event: {
    event_name: string;
    event_type?: string;
    color_theme?: string | null;
  };
  settings: SlideshowSettings;
  photo_count: number;
  expires_at: string | null;
}

// Tiny live-poll payload (settings + current photo count). Hit every few
// seconds by the running show so admin changes and new uploads take effect.
export interface SlideshowState extends SlideshowSettings {
  photo_count: number;
  expires_at: string | null;
}

export const slideshowService = {
  // Open a slideshow session: validates the share token, sets the gallery
  // auth cookie (so <img> requests are authorized) and returns the minted
  // session token + current settings/count. Throws 404 if the link is
  // disabled, rotated, or the gallery isn't live.
  async getSession(slug: string, token: string): Promise<SlideshowSession> {
    // origin: the kiosk's own reachable URL — the backend prefers it for the
    // QR overlay when the configured base is missing/loopback (#848 review;
    // the proxy strips the port from the Host header, so it can't be
    // derived server-side).
    const response = await api.get<SlideshowSession>(`/gallery/${slug}/show/${token}/session`, {
      params: { origin: window.location.origin },
    });
    return response.data;
  },

  async getState(slug: string, token: string): Promise<SlideshowState> {
    const response = await api.get<SlideshowState>(`/gallery/${slug}/show/${token}/state`, {
      params: { origin: window.location.origin },
    });
    return response.data;
  },
};
