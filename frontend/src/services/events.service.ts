import { api } from '../config/api';
import type { AssignedAdmin, Event, GuestNameMode } from '../types';
import { normalizeRequirePassword } from '../utils/accessControl';
import { toBoolean } from '../utils/parsers';

const normalizeEvent = (event: Event): Event => {
  const legacyHostName = (event as any)?.host_name;
  const legacyHostEmail = (event as any)?.host_email;

  const customerName = event.customer_name ?? legacyHostName ?? undefined;
  const customerEmail = event.customer_email ?? legacyHostEmail ?? '';

  return {
    ...event,
    customer_name: customerName,
    customer_email: customerEmail,
    require_password: normalizeRequirePassword((event as any)?.require_password, true),
    // SQLite hands these back as 0/1, so a strict `=== false` consumer reads
    // an inactive gallery as active (the #1028 class). Coerced once here with
    // the same default the backend's parseBooleanInput uses.
    is_active: toBoolean((event as any)?.is_active, true),
  };
};

interface CreateEventData {
  event_type: string;
  event_name: string;
  event_date?: string;
  customer_name?: string;
  customer_email?: string;
  admin_email?: string;
  require_password?: boolean;
  password?: string;
  welcome_message?: string;
  color_theme?: string;
  expiration_days?: number;
  allow_user_uploads?: boolean;
  upload_category_id?: number | null;
  // Uploader names (#1561); omitted = the Event Defaults value.
  guest_name_mode?: GuestNameMode;
  show_credits_to_guests?: boolean;
  feedback_enabled?: boolean;
  allow_ratings?: boolean;
  allow_likes?: boolean;
  allow_comments?: boolean;
  allow_favorites?: boolean;
  allow_reactions?: boolean;
  require_name_email?: boolean;
  moderate_comments?: boolean;
  show_feedback_to_guests?: boolean;
  photo_cap?: number | null;
  download_limit?: number | null;
  default_photo_sort?: string;
  // Customer accounts assigned to this event (#354). Optional array of
  // customer_accounts.id; backend service diffs against the existing
  // assignments and applies inserts/deletes inside the same transaction.
  customer_account_ids?: number[];
  // Team members (issue 743): admin accounts that reach this gallery the way
  // its creator does, and whether their uploads wait for review.
  assigned_admin_ids?: number[];
  review_contributor_uploads?: boolean;
  // Custom styling switch; off = follow the global Branding theme.
  custom_theme_enabled?: boolean;
  // Photo source; import_now starts the folder's first import on create.
  source_mode?: 'managed' | 'reference';
  external_path?: string;
  external_watch?: boolean;
  import_now?: boolean;
}

interface UpdateEventData {
  event_name?: string;
  event_date?: string;
  customer_name?: string;
  customer_email?: string;
  admin_email?: string;
  require_password?: boolean;
  password?: string;
  // Client (photographer's customer) access to the gallery. The plaintext
  // PIN is hashed server-side; `regenerate_client_token` mints a fresh
  // share token. Validated in adminEvents/crud.js on the update route.
  client_access_enabled?: boolean;
  client_password?: string;
  regenerate_client_token?: boolean;
  welcome_message?: string;
  color_theme?: string;
  expires_at?: string;
  is_active?: boolean;
  allow_user_uploads?: boolean;
  guest_name_mode?: GuestNameMode;
  show_credits_to_guests?: boolean;
  // Reveal mode (#838)
  reveal_mode?: boolean;
  reveal_at?: string | null;
  upload_category_id?: number | null;
  hero_photo_id?: number | null;
  source_mode?: 'managed' | 'reference';
  external_path?: string | null;
  external_watch?: boolean;
  photo_cap?: number | null;
  download_limit?: number | null;
  default_photo_sort?: string;
  // Per-event opt-in for hero photo as social-share preview (#474).
  og_image_share_enabled?: boolean;
  // Customer accounts (#354). Same semantics as on CreateEventData;
  // omit the field to leave assignments untouched, send [] to clear.
  customer_account_ids?: number[];
  // Team members (issue 743), the owner's to change. Omit to leave the team
  // untouched, send [] to clear.
  assigned_admin_ids?: number[];
  review_contributor_uploads?: boolean;
}

/** Two-stage delivery state of one gallery (issue 1562). */
export interface DeliveryState {
  status: 'complete' | 'partial';
  expected_count: number | null;
  due_at: string | null;
  /** 'manual' | 'default' */
  due_source: string | null;
  badge_label: string | null;
  completed_at: string | null;
  delivered_count: number;
  first_look_count: number;
  /** First-look photos whose original filename arrived again in the full set. */
  duplicate_count: number;
}

export interface CompleteDeliveryResult {
  completed: boolean;
  email_queued: boolean;
  /** Who the "complete gallery" mail was queued for. */
  recipients?: GalleryNoticeRecipients;
  duplicate_photo_ids: number[];
  state: DeliveryState;
}

/** Who a gallery notice was queued for (galleryNotificationService.describeRecipients). */
export interface GalleryNoticeRecipients {
  /** Got the standard gallery email. */
  email: string | null;
  /** How many accounts got their customer portal email. */
  account_count: number;
  /** Who they are — empty without customers.view. */
  accounts: Array<{ id: number; name: string; email: string }>;
}

export interface DownloadLimitUsage {
  download_limit: number | null;
  downloads_used: number;
  downloads_remaining: number | null;
}

export type EventStatusFilter = 'active' | 'inactive' | 'archived' | 'draft' | 'expiring' | 'awaiting_delivery';

/**
 * Columns the events list can be ordered by. Mirrors SORTABLE in
 * backend/src/routes/adminEvents/listSort.js — `photo_count` and `status` are
 * expressions there, not stored columns. Anything else falls back to
 * created_at desc server-side rather than erroring.
 */
export type EventSortBy =
  | 'event_name'
  | 'event_type'
  | 'event_date'
  | 'created_at'
  | 'updated_at'
  | 'expires_at'
  | 'slug'
  | 'photo_count'
  | 'status';

interface EventsListResponse {
  events: Event[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

/** Query options for the admin events list. */
export interface EventsListParams {
  page?: number;
  limit?: number;
  status?: EventStatusFilter;
  search?: string;
  /** event_types.slug_prefix, as stored on events.event_type. */
  type?: string;
  sortBy?: EventSortBy;
  sortOrder?: 'asc' | 'desc';
}

export const eventsService = {
  // Get all events (admin).
  //
  // Takes an options object rather than positional arguments: with page,
  // limit, status, search, type, sortBy and sortOrder the positional form had
  // callers writing `getEvents(1, 100, undefined, undefined, 'event_date')`,
  // where one misplaced undefined silently sorts by the wrong column.
  async getEvents(options: EventsListParams = {}): Promise<EventsListResponse> {
    const { page = 1, limit = 20, status, search, type, sortBy, sortOrder } = options;
    const params = new URLSearchParams({
      page: page.toString(),
      limit: limit.toString(),
    });

    if (status) {
      params.append('status', status);
    }
    if (search) {
      params.append('search', search);
    }
    if (type) {
      params.append('type', type);
    }
    if (sortBy) {
      params.append('sortBy', sortBy);
    }
    if (sortOrder) {
      params.append('sortOrder', sortOrder);
    }

    const response = await api.get<EventsListResponse>(`/admin/events?${params}`);
    const data: any = response.data;
    if (Array.isArray(data?.events)) {
      data.events = data.events.map((event: Event) => normalizeEvent(event));
    } else if (Array.isArray(data)) {
      return data.map((event: Event) => normalizeEvent(event)) as any;
    }
    return data;
  },

  // Admin accounts a gallery's team can be picked from (issue 743).
  async getAssignableAdmins(): Promise<AssignedAdmin[]> {
    const response = await api.get<{ admins: AssignedAdmin[] }>('/admin/events/assignable-admins');
    return response.data.admins;
  },

  // Get single event details (admin)
  async getEvent(id: number): Promise<Event> {
    const response = await api.get<Event>(`/admin/events/${id}`);
    return normalizeEvent(response.data as Event);
  },

  // Create new event (admin)
  async createEvent(data: CreateEventData): Promise<Event & { import_started?: boolean }> {
    const response = await api.post<Event & { import_started?: boolean }>('/admin/events', data);
    return { ...normalizeEvent(response.data as Event), import_started: response.data.import_started === true };
  },

  // Download limit usage (issue 1560). The limit itself is set through
  // updateEvent; these read and reset what the gallery has used.
  async getDownloadLimitUsage(id: number): Promise<DownloadLimitUsage> {
    const response = await api.get<DownloadLimitUsage>(`/admin/events/${id}/download-limit`);
    return response.data;
  },

  async resetDownloadLimitUsage(id: number): Promise<DownloadLimitUsage> {
    const response = await api.post<DownloadLimitUsage>(`/admin/events/${id}/download-limit/reset`);
    return response.data;
  },

  // Update event (admin)
  // Reveal now (#838): stamps revealed_at so the gallery opens for guests.
  async revealEvent(id: number): Promise<{ revealed_at: string }> {
    const response = await api.post(`/admin/events/${id}/reveal`);
    return response.data;
  },

  // Two-stage delivery (issue 1562): the state read-out for the Delivery
  // section and the event header.
  async getDelivery(id: number): Promise<DeliveryState> {
    const response = await api.get<DeliveryState>(`/admin/events/${id}/delivery`);
    return response.data;
  },

  // "Full gallery is ready". Returns the first-look photos that arrived again
  // in the full set; the caller deletes them through the regular photo delete
  // when the admin asked for it.
  async completeDelivery(id: number, options: { sendEmail: boolean }): Promise<CompleteDeliveryResult> {
    const response = await api.post<CompleteDeliveryResult>(`/admin/events/${id}/delivery/complete`, {
      send_email: options.sendEmail,
    });
    return response.data;
  },

  async updateEvent(id: number, data: UpdateEventData): Promise<Event> {
    const response = await api.put<Event>(`/admin/events/${id}`, data);
    return response.data;
  },

  // Delete/deactivate event (admin)
  async deleteEvent(id: number): Promise<void> {
    await api.delete(`/admin/events/${id}`);
  },

  // Live Slideshow ("Diashow") — mint/rotate the share token (admin)
  async generateSlideshowLink(id: number): Promise<{ show_share_token: string; slideshow_url: string }> {
    const response = await api.post(`/admin/events/${id}/slideshow/generate`);
    return response.data;
  },

  // Disable the slideshow link (null the token) (admin)
  async disableSlideshowLink(id: number): Promise<void> {
    await api.post(`/admin/events/${id}/slideshow/disable`);
  },

  // Update live slideshow settings (display time / transition / style) (admin)
  async updateSlideshowSettings(
    id: number,
    settings: {
      show_interval_ms?: number;
      show_transition?: string;
      show_transition_ms?: number;
      show_watermark?: boolean | null;
      show_qr?: boolean | null;
      show_colorfilter?: string;
      show_order?: string;
      show_category_id?: number | null;
    }
  ): Promise<Record<string, unknown>> {
    const response = await api.patch(`/admin/events/${id}/slideshow`, settings);
    return response.data;
  },

  // Force archive event (admin)
  async archiveEvent(id: number): Promise<void> {
    await api.post(`/admin/events/${id}/archive`);
  },

  // Bulk archive events (admin)
  async bulkArchiveEvents(eventIds: number[]): Promise<{
    message: string;
    results: {
      successful: Array<{ id: number; name: string }>;
      failed: Array<{ id: number; name: string; error: string }>;
    };
  }> {
    const response = await api.post('/admin/events/bulk-archive', {
      eventIds,
    });
    return response.data;
  },

  // Bulk delete events (admin) — destructive. The client-side confirmation
  // gate is a typed-literal pattern in the modal (issue #417); no password
  // is sent because passkey/autofill flows on a password input could
  // auto-submit the form. The admin session JWT remains the auth boundary,
  // matching DELETE /admin/events/:id which has never required a password.
  async bulkDeleteEvents(eventIds: number[]): Promise<{
    message: string;
    results: {
      successful: Array<{ id: number; name: string }>;
      failed: Array<{ id: number; name: string | null; error: string }>;
    };
  }> {
    const response = await api.post('/admin/events/bulk-delete', {
      eventIds,
    });
    return response.data;
  },

  // Extend event expiration (admin). Uses the canonical, ownership-guarded
  // route; the old /events/:id/extend legacy endpoint was removed (GHSA-4j34).
  async extendExpiration(id: number, days: number): Promise<Event> {
    const response = await api.post<Event>(`/admin/events/${id}/extend`, {
      days,
    });
    return response.data;
  },

  // Get event categories
  async getEventCategories(eventId: number): Promise<Array<{ id: number; name: string; slug: string; is_folder?: boolean }>> {
    const response = await api.get(`/admin/categories/event/${eventId}`);
    return response.data || [];
  },

  // Reset event password. Pass `password` to set a specific value (validated
  // server-side with the same rules as create-event); omit it to have the
  // server auto-generate one.
  async resetPassword(
    eventId: number,
    sendEmail: boolean = true,
    password?: string
  ): Promise<{ message: string; newPassword: string; emailSent: boolean }> {
    const body: { sendEmail: boolean; password?: string } = { sendEmail };
    if (password) body.password = password;
    const response = await api.post(`/admin/events/${eventId}/reset-password`, body);
    return response.data;
  },

  // Resend creation email
  async resendCreationEmail(eventId: number): Promise<{ success: boolean; message: string }> {
    const response = await api.post(`/admin/events/${eventId}/resend-email`);
    return response.data;
  },

  // Whether recoverable gallery passwords (#1271) are switched on. Answered
  // per event so editors without settings access can ask too.
  async getGalleryPasswordStatus(eventId: number): Promise<{ enabled: boolean }> {
    const response = await api.get(`/admin/events/${eventId}/password-status`);
    return response.data;
  },

  // Stored gallery password / client PIN (#1271). Only populated when the
  // security setting "gallery_password_recoverable" is on; `enabled: false`
  // means the feature is off and there is nothing to show.
  async getGalleryPassword(eventId: number): Promise<{
    enabled: boolean;
    password: string | null;
    client_password: string | null;
  }> {
    const response = await api.get(`/admin/events/${eventId}/password`);
    return response.data;
  },

  // Validate rename
  async validateRename(eventId: number, newEventName: string): Promise<{
    valid: boolean;
    newSlug?: string;
    error?: string;
  }> {
    const response = await api.post(`/admin/events/${eventId}/validate-rename`, { newEventName });
    return response.data;
  },

  // Publish a draft event. `password` is optional; when the event is
  // password-protected, supplying the password here makes the gallery_created
  // email carry the actual plaintext instead of the "set at creation" sentinel
  // (#627) — the backend also re-hashes it so the stored hash matches.
  async publishEvent(
    eventId: number,
    options?: { password?: string; notifyCustomer?: boolean },
  ): Promise<{ message: string; is_draft: boolean; notified_customer?: boolean }> {
    // Only send what was actually chosen. Omitting notify_customer entirely
    // when it is true keeps the request identical to the pre-#1235 shape.
    const body: Record<string, unknown> = {};
    if (options?.password) body.password = options.password;
    if (options?.notifyCustomer === false) body.notify_customer = false;
    const response = await api.post(
      `/admin/events/${eventId}/publish`,
      Object.keys(body).length ? body : undefined,
    );
    return response.data;
  },

  // Send the gallery email for an already-published gallery (#1235). The other
  // half of publishing quietly: the address often arrives after the gallery
  // does. Also covers an ordinary re-send when the first one was lost.
  async sendGalleryEmail(
    eventId: number,
    options?: { password?: string },
  ): Promise<{ message: string; recipient: string; recipients?: GalleryNoticeRecipients }> {
    const body = options?.password ? { password: options.password } : undefined;
    const response = await api.post(`/admin/events/${eventId}/send-gallery-email`, body);
    return response.data;
  },

  // Duplicate an event (#626). Creates a new draft gallery that inherits the
  // source event's branding + behaviour + feedback + categories. Photos are
  // NOT carried over. The returned id/slug are the new draft event.
  async duplicateEvent(
    eventId: number,
    data: {
      event_name: string;
      event_date?: string;
      customer_name?: string;
      customer_email?: string;
    },
  ): Promise<{ message: string; id: number; slug: string; is_draft: boolean }> {
    const response = await api.post(`/admin/events/${eventId}/duplicate`, data);
    return response.data;
  },

  // Rename event
  async renameEvent(eventId: number, newEventName: string, resendEmail: boolean = false): Promise<{
    success: boolean;
    message?: string;
    data?: {
      eventId: number;
      oldName: string;
      newName: string;
      oldSlug: string;
      newSlug: string;
      newShareLink: string;
      emailSent: boolean;
      filesRenamed: number;
    };
    error?: string;
  }> {
    const response = await api.post(`/admin/events/${eventId}/rename`, { newEventName, resendEmail });
    return response.data;
  },

  // Gallery QR code (#836). Admin API uses Bearer auth, so images are fetched
  // as blobs — an <img src> would not carry the token. `origin` is passed so
  // the backend can fall back to the admin browser's origin when the
  // configured FRONTEND_URL is missing/localhost — the QR must encode the
  // same URL the share-link card displays.
  async getQrBlob(eventId: number, format: 'png' | 'svg', size?: number): Promise<Blob> {
    const { data } = await api.get(`/admin/events/${eventId}/qr`, {
      params: { format, size, origin: window.location.origin },
      responseType: 'blob',
    });
    return data;
  },

  async getQrPrintBlob(eventId: number, template: 'table-card' | 'poster', lang: string): Promise<Blob> {
    const { data } = await api.get(`/admin/events/${eventId}/qr-print`, {
      params: { template, lang, origin: window.location.origin },
      responseType: 'blob',
    });
    return data;
  },
};
