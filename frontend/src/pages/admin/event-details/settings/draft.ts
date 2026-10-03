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
import { format } from 'date-fns';
import type { Event } from '../../../../types';
import type { FeedbackSettings } from '../../../../services/feedback.service';
import { DEFAULT_SLIDESHOW_STYLE, type SlideshowStyle } from '../../../../services/slideshow.service';
import { GALLERY_THEME_PRESETS, type ThemeConfig } from '../../../../types/theme.types';
import { normalizeRequirePassword } from '../../../../utils/accessControl';
import type { CustomerGroup } from '../../../../services/customerAdmin.service';
import type { EditFormState } from '../types';
import { safeParseDate } from '../utils';

export type SettingsSectionKey =
  | 'general'
  | 'access'
  | 'downloads'
  | 'guests'
  | 'appearance'
  | 'source'
  | 'reminder'
  | 'slideshow'
  | 'faces'
  | 'danger';

export interface EventFields extends EditFormState {
  /** Off: the gallery renders the global Branding theme. */
  custom_theme_enabled: boolean;
  /** The gallery's own theme; only written while custom_theme_enabled is on. */
  theme: ThemeConfig;
  event_reminder_disabled: boolean;
  /** '' = inherit the global offset. */
  event_reminder_offset_days: string;
  event_reminder_body_override: string;
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
  if (event.custom_theme_enabled === undefined) {
    return Boolean(event.color_theme) || event.css_template_id != null;
  }
  return truthy(event.custom_theme_enabled);
}

export function eventFieldsFromEvent(event: Event, branding: ThemeConfig | null | undefined): EventFields {
  const expiresAt = safeParseDate(event.expires_at);
  const extra = event as Event & {
    promo_mode?: 'inherit' | 'custom' | 'off';
    info_mode?: 'inherit' | 'custom' | 'off';
    promo_markdown?: string | null;
    info_markdown?: string | null;
    customer_accounts?: Array<{ id: number; email: string; display_name?: string | null; groups?: CustomerGroup[] }>;
  };
  return {
    welcome_message: event.welcome_message || '',
    color_theme: event.color_theme || '',
    css_template_id: event.css_template_id ?? null,
    expires_at: expiresAt ? format(expiresAt, 'yyyy-MM-dd') : '',
    allow_user_uploads: truthy(event.allow_user_uploads),
    reveal_mode: truthy(event.reveal_mode),
    // datetime-local wants local "YYYY-MM-DDTHH:mm"
    reveal_at: event.reveal_at
      ? (() => { const d = new Date(event.reveal_at); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); })()
      : '',
    upload_category_id: event.upload_category_id || null,
    guest_name_mode: event.guest_name_mode || 'off',
    show_credits_to_guests: truthy(event.show_credits_to_guests),
    hero_photo_id: event.hero_photo_id || null,
    customer_name: event.customer_name || '',
    customer_email: event.customer_email || '',
    customer_phone: event.customer_phone || '',
    source_mode: event.source_mode === 'reference' ? 'reference' : 'managed',
    external_path: event.external_path || '',
    external_watch: truthy(event.external_watch),
    require_password: normalizeRequirePassword(event.require_password),
    new_password: '',
    confirm_new_password: '',
    protection_level: event.protection_level || 'standard',
    disable_right_click: event.disable_right_click == null ? true : truthy(event.disable_right_click),
    allow_downloads: event.allow_downloads == null ? true : truthy(event.allow_downloads),
    watermark_downloads: truthy(event.watermark_downloads),
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
    promo_mode: extra.promo_mode || 'inherit',
    info_mode: extra.info_mode || 'inherit',
    promo_markdown: extra.promo_markdown || '',
    info_markdown: extra.info_markdown || '',
    // `groups` only comes with customers.view (#1443).
    customer_accounts: (extra.customer_accounts || [])
      .map((c) => ({ id: c.id, email: c.email, displayName: c.display_name ?? null, groups: c.groups })),
    og_image_share_enabled: truthy(event.og_image_share_enabled),
    custom_theme_enabled: usesCustomTheme(event),
    theme: themeFromEvent(event, branding),
    event_reminder_disabled: truthy(event.event_reminder_disabled),
    event_reminder_offset_days: event.event_reminder_offset_days == null ? '' : String(event.event_reminder_offset_days),
    event_reminder_body_override: event.event_reminder_body_override || '',
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
  };
}

/** Which Settings section owns each events-row field (dirty dots, gating). */
export const SECTION_OF_FIELD: Record<keyof EventFields, SettingsSectionKey> = {
  welcome_message: 'general',
  customer_name: 'general',
  customer_email: 'general',
  customer_phone: 'general',
  customer_accounts: 'general',
  expires_at: 'access',
  require_password: 'access',
  new_password: 'access',
  confirm_new_password: 'access',
  photo_cap: 'downloads',
  download_limit: 'downloads',
  default_photo_sort: 'downloads',
  protection_level: 'downloads',
  disable_right_click: 'downloads',
  allow_downloads: 'downloads',
  watermark_downloads: 'downloads',
  enable_devtools_protection: 'downloads',
  use_canvas_rendering: 'downloads',
  allow_user_uploads: 'guests',
  upload_category_id: 'guests',
  guest_name_mode: 'guests',
  show_credits_to_guests: 'guests',
  reveal_mode: 'guests',
  reveal_at: 'guests',
  hero_photo_id: 'appearance',
  og_image_share_enabled: 'appearance',
  hero_image_anchor: 'appearance',
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
  color_theme: 'appearance',
  css_template_id: 'appearance',
  source_mode: 'source',
  external_path: 'source',
  external_watch: 'source',
  event_reminder_disabled: 'reminder',
  event_reminder_offset_days: 'reminder',
  event_reminder_body_override: 'reminder',
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
  return out;
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
  };
}

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
    expires_at: f.expires_at || null,
    require_password: f.require_password,
    allow_user_uploads: f.allow_user_uploads,
    upload_category_id: f.upload_category_id,
    guest_name_mode: f.guest_name_mode,
    show_credits_to_guests: f.show_credits_to_guests,
    reveal_mode: reveal,
    reveal_at: reveal && f.reveal_at ? new Date(f.reveal_at).toISOString() : null,
    protection_level: f.protection_level,
    disable_right_click: f.disable_right_click,
    allow_downloads: f.allow_downloads,
    watermark_downloads: f.watermark_downloads,
    enable_devtools_protection: f.enable_devtools_protection,
    use_canvas_rendering: f.use_canvas_rendering,
    photo_cap: f.photo_cap > 0 ? f.photo_cap : null,
    download_limit: f.download_limit > 0 ? f.download_limit : null,
    default_photo_sort: f.default_photo_sort,
    hero_photo_id: f.hero_photo_id,
    og_image_share_enabled: f.og_image_share_enabled,
    hero_image_anchor: f.hero_image_anchor,
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

/** The fields to PUT, or null when the events row is unchanged. */
export function eventUpdatePayload(
  draft: EventFields,
  base: EventFields,
  t: Translate,
): Record<string, unknown> | null {
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
  };
}
