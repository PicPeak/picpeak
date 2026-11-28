/**
 * The gallery Settings tab edits one draft and saves it through one bar
 * (SettingsSaveBar), the way the admin Settings pages do. The draft has a
 * slice per endpoint the settings live behind:
 *
 *   event       PUT /admin/events/:id         (everything on the events row)
 *   feedback    PUT feedback-settings         (Guest interaction → feedback)
 *   downloads   PATCH download-resolutions    (Downloads → resolution)
 *   slideshow   PATCH slideshow               (Slideshow → style)
 *
 * Save sends only what changed: each slice is compared with the server state
 * it was loaded from, and the events row only receives the fields whose
 * request value differs. A save the admin never touched writes nothing.
 */
import type { AssignedAdmin, Event } from '../../../../types';
import type { FeedbackSettings } from '../../../../services/feedback.service';
import { DEFAULT_SLIDESHOW_STYLE, SLIDESHOW_FITS, type SlideshowStyle } from '../../../../services/slideshow.service';
import { GALLERY_THEME_PRESETS, type ThemeConfig } from '../../../../types/theme.types';
import { normalizeRequirePassword } from '../../../../utils/accessControl';
import { expiryDay } from '../../../../utils/expiryDay';
import type { CustomerGroup } from '../../../../services/customerAdmin.service';
import type { GuestNameMode, HighlightsMode, TextLanguageMode } from '../../../../types';
import type { ContentTranslation, TranslationChange } from '../../../../services/translations.service';
import { safeParseDate } from '../utils';

export type SettingsSectionKey =
  | 'general'
  | 'access'
  | 'downloads'
  | 'pricing'
  | 'guests'
  | 'appearance'
  | 'source'
  | 'delivery'
  | 'reminder'
  | 'slideshow'
  | 'embed'
  | 'website'
  | 'faces'
  | 'tags'
  | 'languages'
  | 'danger';

// The sections a link can open (`?section=`).
const LINKED_SECTIONS: SettingsSectionKey[] = ['general', 'access', 'downloads', 'pricing', 'guests', 'appearance', 'source', 'delivery', 'reminder', 'slideshow', 'embed', 'website', 'faces', 'tags', 'danger'];

export function isLinkedSection(value: string | null): value is SettingsSectionKey {
  return value !== null && (LINKED_SECTIONS as string[]).includes(value);
}

export interface EventFields {
  welcome_message: string;
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
  // First-visit walkthrough for clients and guests (issue 2551)
  walkthrough_enabled: boolean;
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
  // Chapter markers above the categories (issue 2548).
  chapter_marker_style: 'off' | 'divider' | 'hero';
  // Which photos get the larger tiles (issue 2549).
  highlights_mode: HighlightsMode;
  highlights_threshold: number;
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
  // The public website opt-in (issue 2618).
  show_on_website: boolean;
  temporarily_disabled: boolean;
  /**
   * Read-only. The gallery's password was generated for portal-only access
   * (migration 264) and no customer email has been told it, so adding one
   * needs a real password first — the gallery email carries it.
   */
  generated_password_pending: boolean;
  /** Off: the gallery renders the global Branding theme. */
  custom_theme_enabled: boolean;
  /** The gallery's own theme; only written while custom_theme_enabled is on. */
  theme: ThemeConfig;
  event_reminder_disabled: boolean;
  /** '' = inherit the global offset. */
  event_reminder_offset_days: string;
  event_reminder_body_override: string;
  /** Mirror subfolders of uploads and imports as gallery folders (issue 1786). */
  folder_structure: boolean;
  /** Two-stage delivery (issue 1562). */
  delivery_status: 'complete' | 'partial';
  /** '' = not set. */
  delivery_expected_count: string;
  /** 'yyyy-MM-dd', '' = not set. */
  delivery_due_at: string;
  /** '' = the translated default ("First look"). */
  delivery_badge_label: string;
  /** Team members (issue 743); only the owner changes them. */
  assigned_admins: AssignedAdmin[];
  /** Hold the team members' uploads until the owner approves them. */
  review_contributor_uploads: boolean;
  /** Hold guest uploads until the owner or a reviewer approves them. */
  moderate_guest_uploads: boolean;
  /** Multilingual texts (issue 2550). */
  text_language_mode: TextLanguageMode;
  text_primary_language: string | null;
  text_secondary_language: string | null;
}

/**
 * The gallery title's and welcome message's translations (issue 2550),
 * keyed `${field}:${language}`, saved through PUT /:id/translations. Category
 * and chapter texts are edited and saved in the category manager.
 */
export type EventTextsDraft = Record<string, string>;

export const EVENT_TEXT_FIELDS = ['event_name', 'welcome_message'] as const;
export type EventTextField = typeof EVENT_TEXT_FIELDS[number];

/** Which Settings section shows each translated event field. */
const SECTION_OF_TEXT_FIELD: Record<EventTextField, SettingsSectionKey> = {
  event_name: 'languages',
  welcome_message: 'general',
};

const textFieldOf = (key: string) => key.split(':')[0] as EventTextField;

export function eventTextsFromRows(rows: ContentTranslation[] | undefined, eventId: number): EventTextsDraft | null {
  if (!rows) return null;
  const out: EventTextsDraft = {};
  for (const row of rows) {
    if (row.entity_type === 'event' && Number(row.entity_id) === Number(eventId)
      && (EVENT_TEXT_FIELDS as readonly string[]).includes(row.field)) {
      out[`${row.field}:${row.language}`] = row.text;
    }
  }
  return out;
}

/** `${field}:${language}` → text, for one event field. */
export function textsOfField(texts: EventTextsDraft | null, field: string): Partial<Record<string, string>> {
  const out: Partial<Record<string, string>> = {};
  for (const [key, value] of Object.entries(texts || {})) {
    const [f, language] = key.split(':');
    if (f === field) out[language] = value;
  }
  return out;
}

/** The translation writes this draft stands for; an emptied text removes the row. */
export function eventTextChanges(draft: EventTextsDraft | null | undefined, base: EventTextsDraft | null | undefined, eventId: number): TranslationChange[] {
  if (!draft || !base) return [];
  const keys = new Set([...Object.keys(draft), ...Object.keys(base)]);
  const changes: TranslationChange[] = [];
  for (const key of keys) {
    const next = (draft[key] ?? '').trim();
    const prev = (base[key] ?? '').trim();
    if (next === prev) continue;
    const [field, language] = key.split(':');
    changes.push({ entity_type: 'event', entity_id: eventId, field, language, text: next === '' ? null : next });
  }
  return changes;
}

/**
 * Per key, like the events row: a text the admin has not touched follows the
 * server, so a translation saved elsewhere meanwhile is neither lost from
 * the draft nor deleted by the next save. Before they first load, the server's.
 */
function rebaseTexts(current: EventTextsDraft | null | undefined, prevBase: EventTextsDraft | null | undefined, server: EventTextsDraft | null | undefined) {
  if (!current || !prevBase || !server) return server;
  const out: EventTextsDraft = {};
  for (const key of new Set([...Object.keys(current), ...Object.keys(prevBase), ...Object.keys(server)])) {
    const touched = (current[key] ?? '') !== (prevBase[key] ?? '');
    const value = touched ? current[key] : server[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** The draft's texts with the keys of one section put back to `base`. */
function resetTexts(draft: EventTextsDraft | null | undefined, base: EventTextsDraft | null | undefined, section: SettingsSectionKey) {
  if (!draft || !base) return draft;
  const out: EventTextsDraft = {};
  for (const [key, value] of Object.entries(draft)) if (SECTION_OF_TEXT_FIELD[textFieldOf(key)] !== section) out[key] = value;
  for (const [key, value] of Object.entries(base)) if (SECTION_OF_TEXT_FIELD[textFieldOf(key)] === section) out[key] = value;
  return out;
}

export const INHERIT = '__inherit__';

export interface DownloadsDraft {
  /** INHERIT, 'original', or a resolution id. */
  standard: string;
  /** INHERIT, 'true' or 'false'. */
  picker: string;
  allowOriginal: string;
}

export interface EventSettingsDraft {
  event: EventFields;
  feedback: FeedbackSettings | null;
  downloads: DownloadsDraft | null;
  slideshow: SlideshowStyle | null;
  /** Null until loaded; absent in drafts built before issue 2550. */
  translations?: EventTextsDraft | null;
}

const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true';

/**
 * The theme the editor starts from: the gallery's own, else Branding. While
 * custom styling is ON the gallery renders its header and hero divider
 * columns ahead of the theme, so those go on top. While it is OFF the gallery
 * renders Branding's header (backend services/galleryTheme), and the columns
 * may be stale — overlaying them would hand the editor, and the next save, a
 * header the gallery does not show.
 */
export function themeFromEvent(event: Event, branding: ThemeConfig | null | undefined): ThemeConfig {
  const stored = event.color_theme;
  let theme: ThemeConfig = branding ?? GALLERY_THEME_PRESETS.default.config;
  if (stored) {
    if (stored.startsWith('{')) {
      try {
        theme = JSON.parse(stored) as ThemeConfig;
      } catch {
        // keep Branding
      }
    } else if (GALLERY_THEME_PRESETS[stored]) {
      theme = GALLERY_THEME_PRESETS[stored].config;
    }
  }
  if (!usesCustomTheme(event)) return theme;
  const e = event as Event & { header_style?: string | null; hero_divider_style?: string | null };
  return {
    ...theme,
    ...(e.header_style ? { headerStyle: e.header_style as ThemeConfig['headerStyle'] } : {}),
    ...(e.hero_divider_style ? { heroDividerStyle: e.hero_divider_style as ThemeConfig['heroDividerStyle'] } : {}),
  };
}

export function usesCustomTheme(event: Event): boolean {
  return truthy(event.custom_theme_enabled);
}

/**
 * The date field's value for a stored expiry: the day it stands for in the
 * instance time zone (`timeZone`, from the event detail payload). See
 * utils/expiryDay for the stored shapes.
 */
export function expiryDateField(value: unknown, timeZone?: string | null): string {
  const date = safeParseDate(value);
  return date ? expiryDay(date, timeZone) : '';
}

/**
 * The date field's value for a stored delivery due date: its UTC date, the
 * day deliveryDue() and the backend's due/overdue checks read. The field
 * stores noon UTC, which the browser zone would push to the next day east of
 * UTC+12.
 */
export function deliveryDueDateField(value: unknown): string {
  const date = safeParseDate(value);
  return date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : '';
}

export function eventFieldsFromEvent(event: Event, branding: ThemeConfig | null | undefined): EventFields {
  const extra = event as Event & {
    promo_mode?: 'inherit' | 'custom' | 'off';
    info_mode?: 'inherit' | 'custom' | 'off';
    promo_markdown?: string | null;
    info_markdown?: string | null;
    customer_accounts?: Array<{ id: number; email: string; display_name?: string | null; groups?: CustomerGroup[] }>;
  };
  return {
    welcome_message: event.welcome_message || '',
    css_template_id: event.css_template_id ?? null,
    expires_at: expiryDateField(event.expires_at, event.expiry_time_zone),
    allow_user_uploads: truthy(event.allow_user_uploads),
    reveal_mode: truthy(event.reveal_mode),
    // datetime-local wants local "YYYY-MM-DDTHH:mm"
    reveal_at: event.reveal_at
      ? (() => { const d = new Date(event.reveal_at); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); })()
      : '',
    upload_category_id: event.upload_category_id || null,
    guest_upload_max_edge: event.guest_upload_max_edge ? String(event.guest_upload_max_edge) : '',
    guest_name_mode: event.guest_name_mode || 'off',
    show_credits_to_guests: truthy(event.show_credits_to_guests),
    live_refresh: truthy(event.live_refresh),
    show_exif_to_guests: truthy(event.show_exif_to_guests),
    neutral_photo_labels: truthy(event.neutral_photo_labels),
    walkthrough_enabled: truthy(event.walkthrough_enabled),
    hero_photo_id: event.hero_photo_id || null,
    customer_name: event.customer_name || '',
    customer_email: event.customer_email || '',
    customer_phone: event.customer_phone || '',
    generated_password_pending: truthy((event as Event & { password_generated?: unknown }).password_generated) && !event.customer_email,
    source_mode: event.source_mode === 'reference' ? 'reference' : 'managed',
    external_path: event.external_path || '',
    external_watch: truthy(event.external_watch),
    require_password: normalizeRequirePassword(event.require_password),
    temporarily_disabled: truthy(event.temporarily_disabled),
    new_password: '',
    confirm_new_password: '',
    protection_level: event.protection_level || 'standard',
    disable_right_click: event.disable_right_click == null ? true : truthy(event.disable_right_click),
    allow_downloads: event.allow_downloads == null ? true : truthy(event.allow_downloads),
    watermark_downloads: truthy(event.watermark_downloads),
    watermark_text: event.watermark_text || '',
    enable_devtools_protection: event.enable_devtools_protection == null ? true : truthy(event.enable_devtools_protection),
    use_canvas_rendering: truthy(event.use_canvas_rendering),
    // null = inherit the global branding toggle / size (#756)
    hero_logo_visible: event.hero_logo_visible == null ? null : truthy(event.hero_logo_visible),
    hero_logo_size: event.hero_logo_size ?? null,
    hero_logo_position: event.hero_logo_position || 'top',
    // #894: null = default (show); only false hides the password-page logo.
    login_logo_visible: event.login_logo_visible == null ? null : truthy(event.login_logo_visible),
    hero_image_anchor: event.hero_image_anchor || 'center',
    photo_cap: event.photo_cap || 0,
    download_limit: event.download_limit || 0,
    default_photo_sort: event.default_photo_sort || 'upload_date_desc',
    videos_first: truthy(event.videos_first),
    chapter_marker_style: event.chapter_marker_style === 'divider' || event.chapter_marker_style === 'hero'
      ? event.chapter_marker_style : 'off',
    highlights_mode: event.highlights_mode === 'manual' || event.highlights_mode === 'rating' ? event.highlights_mode : 'off',
    highlights_threshold: event.highlights_threshold || 4,
    // Photo sales pricing for paid galleries.
    is_priced: truthy(event.is_priced),
    free_photo_count: Number(event.free_photo_count ?? 0),
    photo_price: Number(event.photo_price ?? 0),
    purchase_access_days: Number(event.purchase_access_days ?? 30),
    promo_mode: extra.promo_mode || 'inherit',
    info_mode: extra.info_mode || 'inherit',
    promo_markdown: extra.promo_markdown || '',
    info_markdown: extra.info_markdown || '',
    // `groups` only comes with customers.view (#1443).
    customer_accounts: (extra.customer_accounts || [])
      .map((c) => ({ id: c.id, email: c.email, displayName: c.display_name ?? null, groups: c.groups })),
    og_image_share_enabled: truthy(event.og_image_share_enabled),
    show_on_website: truthy(event.show_on_website),
    custom_theme_enabled: usesCustomTheme(event),
    theme: themeFromEvent(event, branding),
    event_reminder_disabled: truthy(event.event_reminder_disabled),
    event_reminder_offset_days: event.event_reminder_offset_days == null ? '' : String(event.event_reminder_offset_days),
    event_reminder_body_override: event.event_reminder_body_override || '',
    folder_structure: truthy(event.folder_structure),
    delivery_status: event.delivery_status === 'partial' ? 'partial' : 'complete',
    delivery_expected_count: event.delivery_expected_count ? String(event.delivery_expected_count) : '',
    delivery_due_at: deliveryDueDateField(event.delivery_due_at),
    delivery_badge_label: event.delivery_badge_label || '',
    assigned_admins: event.assigned_admins || [],
    review_contributor_uploads: truthy(event.review_contributor_uploads),
    moderate_guest_uploads: truthy(event.moderate_guest_uploads),
    text_language_mode: event.text_language_mode === 'visitor' || event.text_language_mode === 'bilingual'
      ? event.text_language_mode : 'off',
    text_primary_language: event.text_primary_language || null,
    text_secondary_language: event.text_secondary_language || null,
  };
}

export function slideshowFromEvent(event: Event): SlideshowStyle {
  const mode = (v: boolean | null | undefined): SlideshowStyle['watermark'] =>
    (v === null || v === undefined ? 'inherit' : v ? 'on' : 'off');
  const e = event as Event & { show_order?: string; show_category_id?: number | null };
  return {
    interval_ms: event.show_interval_ms ?? DEFAULT_SLIDESHOW_STYLE.interval_ms,
    transition: (event.show_transition as SlideshowStyle['transition']) ?? DEFAULT_SLIDESHOW_STYLE.transition,
    transition_ms: event.show_transition_ms ?? DEFAULT_SLIDESHOW_STYLE.transition_ms,
    watermark: mode(event.show_watermark),
    qr: mode(event.show_qr),
    colorfilter: (event.show_colorfilter as SlideshowStyle['colorfilter']) ?? DEFAULT_SLIDESHOW_STYLE.colorfilter,
    order: (e.show_order as SlideshowStyle['order']) ?? DEFAULT_SLIDESHOW_STYLE.order,
    category_id: e.show_category_id ?? null,
    fit: event.show_fit && SLIDESHOW_FITS.includes(event.show_fit) ? event.show_fit : 'inherit',
  };
}

/** Which Settings section owns each events-row field (dirty dots, gating). */
export const SECTION_OF_FIELD: Record<keyof EventFields, SettingsSectionKey> = {
  welcome_message: 'general',
  customer_name: 'general',
  customer_email: 'general',
  customer_phone: 'general',
  customer_accounts: 'general',
  generated_password_pending: 'general',
  assigned_admins: 'general',
  review_contributor_uploads: 'general',
  expires_at: 'access',
  require_password: 'access',
  temporarily_disabled: 'access',
  new_password: 'access',
  confirm_new_password: 'access',
  photo_cap: 'downloads',
  download_limit: 'downloads',
  default_photo_sort: 'downloads',
  videos_first: 'downloads',
  highlights_mode: 'downloads',
  highlights_threshold: 'downloads',
  is_priced: 'pricing',
  free_photo_count: 'pricing',
  photo_price: 'pricing',
  purchase_access_days: 'pricing',
  protection_level: 'downloads',
  disable_right_click: 'downloads',
  allow_downloads: 'downloads',
  watermark_downloads: 'downloads',
  watermark_text: 'downloads',
  enable_devtools_protection: 'downloads',
  use_canvas_rendering: 'downloads',
  allow_user_uploads: 'guests',
  upload_category_id: 'guests',
  moderate_guest_uploads: 'guests',
  guest_upload_max_edge: 'guests',
  guest_name_mode: 'guests',
  show_credits_to_guests: 'guests',
  live_refresh: 'guests',
  show_exif_to_guests: 'guests',
  neutral_photo_labels: 'guests',
  walkthrough_enabled: 'guests',
  reveal_mode: 'guests',
  reveal_at: 'guests',
  hero_photo_id: 'appearance',
  og_image_share_enabled: 'appearance',
  show_on_website: 'website',
  hero_image_anchor: 'appearance',
  chapter_marker_style: 'appearance',
  hero_logo_visible: 'appearance',
  hero_logo_size: 'appearance',
  hero_logo_position: 'appearance',
  login_logo_visible: 'appearance',
  promo_mode: 'appearance',
  promo_markdown: 'appearance',
  info_mode: 'appearance',
  info_markdown: 'appearance',
  custom_theme_enabled: 'appearance',
  theme: 'appearance',
  css_template_id: 'appearance',
  source_mode: 'source',
  external_path: 'source',
  external_watch: 'source',
  event_reminder_disabled: 'reminder',
  event_reminder_offset_days: 'reminder',
  event_reminder_body_override: 'reminder',
  folder_structure: 'delivery',
  delivery_status: 'delivery',
  delivery_expected_count: 'delivery',
  delivery_due_at: 'delivery',
  delivery_badge_label: 'delivery',
  text_language_mode: 'languages',
  text_primary_language: 'languages',
  text_secondary_language: 'languages',
};

/** Key-order independent JSON, so two equal drafts always compare equal. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort()
      .filter((k) => obj[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export const sameValue = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);

/** The sections whose fields differ between the draft and the server state. */
export function dirtySections(draft: EventSettingsDraft, base: EventSettingsDraft): Set<SettingsSectionKey> {
  const out = new Set<SettingsSectionKey>();
  for (const key of Object.keys(SECTION_OF_FIELD) as Array<keyof EventFields>) {
    if (!sameValue(draft.event[key], base.event[key])) out.add(SECTION_OF_FIELD[key]);
  }
  if (!sameValue(draft.feedback, base.feedback)) out.add('guests');
  if (!sameValue(draft.downloads, base.downloads)) out.add('downloads');
  if (!sameValue(draft.slideshow, base.slideshow)) out.add('slideshow');
  if (draft.translations && base.translations) {
    for (const change of eventTextChanges(draft.translations, base.translations, 0)) {
      out.add(SECTION_OF_TEXT_FIELD[change.field as EventTextField]);
    }
  }
  return out;
}

/**
 * The draft with one section put back to the server state ("Undo changes in
 * this section"). Every other section keeps its edits.
 */
export function resetSection(draft: EventSettingsDraft, base: EventSettingsDraft, section: SettingsSectionKey): EventSettingsDraft {
  const fields = { ...draft.event } as Record<string, unknown>;
  const baseFields = base.event as unknown as Record<string, unknown>;
  (Object.keys(SECTION_OF_FIELD) as Array<keyof EventFields>).forEach((key) => {
    if (SECTION_OF_FIELD[key] === section) fields[key] = baseFields[key];
  });
  return {
    event: fields as unknown as EventFields,
    feedback: section === 'guests' ? base.feedback : draft.feedback,
    downloads: section === 'downloads' ? base.downloads : draft.downloads,
    slideshow: section === 'slideshow' ? base.slideshow : draft.slideshow,
    translations: resetTexts(draft.translations, base.translations, section),
  };
}

/**
 * The draft after the server state moved from `prevBase` to `server`. On the
 * events row this goes per FIELD: a field the admin has not touched takes the
 * server value, so a change made elsewhere (an instant action, another admin,
 * an import repointing the folder) is not written back from a stale draft on
 * the next save. The smaller slices follow as a whole.
 */
export function rebaseDraft(current: EventSettingsDraft, prevBase: EventSettingsDraft, server: EventSettingsDraft): EventSettingsDraft {
  const fields = { ...current.event } as Record<string, unknown>;
  const prevFields = prevBase.event as unknown as Record<string, unknown>;
  const serverFields = server.event as unknown as Record<string, unknown>;
  Object.keys(serverFields).forEach((key) => {
    if (sameValue(fields[key], prevFields[key])) fields[key] = serverFields[key];
  });
  const slice = <K extends 'feedback' | 'downloads' | 'slideshow'>(k: K) =>
    (sameValue(current[k], prevBase[k]) ? server[k] : current[k]);
  return {
    event: fields as unknown as EventFields,
    feedback: slice('feedback'),
    downloads: slice('downloads'),
    slideshow: slice('slideshow'),
    translations: rebaseTexts(current.translations, prevBase.translations, server.translations),
  };
}

// The range the server accepts (services/guestUploadDownscale.js).
export const GUEST_UPLOAD_MIN_EDGE = 1024;
export const GUEST_UPLOAD_MAX_EDGE = 16384;

export class DraftValidationError extends Error {
  readonly section: SettingsSectionKey;

  constructor(message: string, section: SettingsSectionKey) {
    super(message);
    this.section = section;
  }
}

type Translate = (key: string, fallback: string) => string;

/**
 * The PUT /admin/events/:id body this draft stands for. Built the same way for
 * the draft and for the server state, so their difference is exactly what the
 * admin changed.
 */
function requestFields(f: EventFields): Record<string, unknown> {
  const reveal = f.allow_user_uploads && f.reveal_mode;
  const offset = f.event_reminder_offset_days.trim();
  const body: Record<string, unknown> = {
    welcome_message: f.welcome_message,
    customer_name: f.customer_name,
    // '' as null so an admin can clear them (issue 1733; the email used to
    // go out as undefined, which the payload loop skips, so it could never be
    // cleared). The backend refuses the clear where Settings require the
    // field, and drops the phone when the global phone field is off.
    customer_email: f.customer_email.trim() || null,
    customer_phone: f.customer_phone.trim() || null,
    customer_account_ids: f.customer_accounts.map((c) => c.id),
    // Only sent when changed, so a team member's save never carries them.
    assigned_admin_ids: f.assigned_admins.map((a) => a.id),
    review_contributor_uploads: f.review_contributor_uploads,
    expires_at: f.expires_at || null,
    require_password: f.require_password,
    temporarily_disabled: f.temporarily_disabled,
    allow_user_uploads: f.allow_user_uploads,
    upload_category_id: f.upload_category_id,
    moderate_guest_uploads: f.moderate_guest_uploads,
    guest_upload_max_edge: f.guest_upload_max_edge.trim() === '' ? null : Number(f.guest_upload_max_edge),
    guest_name_mode: f.guest_name_mode,
    show_credits_to_guests: f.show_credits_to_guests,
    live_refresh: f.live_refresh,
    show_exif_to_guests: f.show_exif_to_guests,
    neutral_photo_labels: f.neutral_photo_labels,
    walkthrough_enabled: f.walkthrough_enabled,
    reveal_mode: reveal,
    reveal_at: reveal && f.reveal_at ? new Date(f.reveal_at).toISOString() : null,
    protection_level: f.protection_level,
    disable_right_click: f.disable_right_click,
    allow_downloads: f.allow_downloads,
    watermark_downloads: f.watermark_downloads,
    watermark_text: f.watermark_text.trim(),
    enable_devtools_protection: f.enable_devtools_protection,
    use_canvas_rendering: f.use_canvas_rendering,
    photo_cap: f.photo_cap > 0 ? f.photo_cap : null,
    download_limit: f.download_limit > 0 ? f.download_limit : null,
    default_photo_sort: f.default_photo_sort,
    videos_first: f.videos_first,
    highlights_mode: f.highlights_mode,
    highlights_threshold: f.highlights_threshold,
    is_priced: f.is_priced,
    free_photo_count: f.free_photo_count > 0 ? f.free_photo_count : null,
    photo_price: f.photo_price > 0 ? f.photo_price : null,
    purchase_access_days: f.purchase_access_days,
    hero_photo_id: f.hero_photo_id,
    og_image_share_enabled: f.og_image_share_enabled,
    show_on_website: f.show_on_website,
    hero_image_anchor: f.hero_image_anchor,
    chapter_marker_style: f.chapter_marker_style,
    text_language_mode: f.text_language_mode,
    text_primary_language: f.text_primary_language || null,
    text_secondary_language: f.text_secondary_language || null,
    hero_logo_visible: f.hero_logo_visible,
    hero_logo_size: f.hero_logo_size,
    hero_logo_position: f.hero_logo_position,
    login_logo_visible: f.login_logo_visible,
    promo_mode: f.promo_mode,
    promo_markdown: f.promo_mode === 'custom' ? f.promo_markdown : null,
    info_mode: f.info_mode,
    info_markdown: f.info_mode === 'custom' ? f.info_markdown : null,
    source_mode: f.source_mode,
    external_path: f.source_mode === 'reference' ? f.external_path.trim() : null,
    external_watch: f.source_mode === 'reference' && f.external_watch,
    custom_theme_enabled: f.custom_theme_enabled,
    event_reminder_disabled: f.event_reminder_disabled,
    event_reminder_offset_days: offset === '' ? null : Math.floor(Number(offset)),
    event_reminder_body_override: f.event_reminder_body_override.trim() === '' ? null : f.event_reminder_body_override,
    folder_structure: f.folder_structure,
    delivery_status: f.delivery_status,
    delivery_expected_count: f.delivery_expected_count.trim() === '' ? null : Math.floor(Number(f.delivery_expected_count)),
    // Noon UTC: a calendar date that reads the same in every timezone.
    delivery_due_at: f.delivery_due_at ? `${f.delivery_due_at}T12:00:00.000Z` : null,
    delivery_badge_label: f.delivery_badge_label.trim() === '' ? null : f.delivery_badge_label.trim(),
  };
  // The gallery's own look is only written while it is in use; switching
  // custom styling off leaves the stored theme for a later switch back on.
  if (f.custom_theme_enabled) {
    body.color_theme = JSON.stringify(f.theme);
    body.css_template_id = f.css_template_id;
    body.header_style = f.theme.headerStyle || 'standard';
    body.hero_divider_style = f.theme.heroDividerStyle || 'wave';
  }
  return body;
}

/** Adding a customer email to this gallery needs a password first (see generated_password_pending). */
export function emailNeedsPassword(f: EventFields): boolean {
  return f.generated_password_pending && f.require_password && !!f.customer_email.trim();
}

/** The fields to PUT, or null when the events row is unchanged. */
export function eventUpdatePayload(
  draft: EventFields,
  base: EventFields,
  t: Translate,
): Record<string, unknown> | null {
  if (emailNeedsPassword(draft) && !draft.new_password) {
    throw new DraftValidationError(t('events.recipients.passwordForEmailRequired', 'Set a gallery password before adding the customer email — the gallery email carries it.'), 'general');
  }
  if (draft.require_password) {
    if (draft.require_password !== base.require_password && !draft.new_password) {
      throw new DraftValidationError(t('events.newPasswordRequired', 'Please set a password before enabling protection.'), 'access');
    }
    if (draft.new_password) {
      if (draft.new_password.length < 6) {
        throw new DraftValidationError(t('validation.passwordMinLength', 'Password must be at least 6 characters'), 'access');
      }
      if (draft.new_password !== draft.confirm_new_password) {
        throw new DraftValidationError(t('validation.passwordsDoNotMatch', 'Passwords do not match'), 'access');
      }
    }
  }
  if (draft.source_mode === 'reference' && !draft.external_path.trim()) {
    throw new DraftValidationError(t('events.externalFolderRequired', 'Please select an external folder before saving.'), 'source');
  }
  const offset = draft.event_reminder_offset_days.trim();
  if (offset !== '' && (!Number.isFinite(Number(offset)) || Number(offset) < 0)) {
    throw new DraftValidationError(t('eventReminderOverride.invalidOffset', 'Offset must be a non-negative integer or blank.'), 'reminder');
  }
  const maxEdge = draft.guest_upload_max_edge.trim();
  if (maxEdge !== '' && (!Number.isInteger(Number(maxEdge))
    || Number(maxEdge) < GUEST_UPLOAD_MIN_EDGE || Number(maxEdge) > GUEST_UPLOAD_MAX_EDGE)) {
    throw new DraftValidationError(
      t('events.guestUploadMaxEdgeInvalid', 'The longest edge must be a whole number from 1024 to 16384, or empty.'),
      'guests',
    );
  }
  if (draft.text_language_mode !== 'off' && !draft.text_primary_language) {
    throw new DraftValidationError(t('events.languages.primaryRequired', 'Choose the language the gallery texts are written in.'), 'languages');
  }
  if (draft.text_language_mode === 'bilingual'
    && (!draft.text_secondary_language || draft.text_secondary_language === draft.text_primary_language)) {
    throw new DraftValidationError(t('events.languages.secondaryRequired', 'Choose a second language, different from the first, for the bilingual gallery.'), 'languages');
  }
  const expected = draft.delivery_expected_count.trim();
  if (expected !== '' && (!Number.isInteger(Number(expected)) || Number(expected) < 1)) {
    throw new DraftValidationError(t('events.delivery.invalidExpected', 'The expected number of photos must be a whole number above 0, or empty.'), 'delivery');
  }

  const next = requestFields(draft);
  const prev = requestFields(base);
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) continue;
    if (!sameValue(value, prev[key])) payload[key] = value;
  }
  // Theme fields travel together, so header_style never disagrees with the
  // stored theme JSON.
  if (draft.custom_theme_enabled && ['color_theme', 'header_style', 'hero_divider_style', 'css_template_id', 'custom_theme_enabled'].some((k) => k in payload)) {
    for (const key of ['color_theme', 'css_template_id', 'header_style', 'hero_divider_style', 'custom_theme_enabled']) {
      payload[key] = next[key];
    }
  }
  if (draft.new_password) payload.password = draft.new_password;
  return Object.keys(payload).length > 0 ? payload : null;
}

export function downloadsPayload(d: DownloadsDraft) {
  const tri = (v: string) => (v === INHERIT ? null : v === 'true');
  return {
    download_standard_resolution: d.standard === INHERIT ? null : d.standard,
    download_resolution_picker_enabled: tri(d.picker),
    download_allow_original: tri(d.allowOriginal),
  };
}

export function slideshowPayload(s: SlideshowStyle) {
  const tri = (v: SlideshowStyle['watermark']) => (v === 'inherit' ? null : v === 'on');
  return {
    show_interval_ms: s.interval_ms,
    show_transition: s.transition,
    show_transition_ms: s.transition_ms,
    show_watermark: tri(s.watermark),
    show_qr: tri(s.qr),
    show_colorfilter: s.colorfilter,
    show_order: s.order,
    show_category_id: s.category_id,
    show_fit: s.fit === 'inherit' ? null : s.fit,
  };
}
