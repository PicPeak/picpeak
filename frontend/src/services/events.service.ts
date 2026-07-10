import { api } from '../config/api';
import type { Event } from '../types';
import { normalizeRequirePassword } from '../utils/accessControl';

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
  feedback_enabled?: boolean;
  allow_ratings?: boolean;
  allow_likes?: boolean;
  allow_comments?: boolean;
  allow_favorites?: boolean;
  require_name_email?: boolean;
  moderate_comments?: boolean;
  show_feedback_to_guests?: boolean;
  photo_cap?: number | null;
  default_photo_sort?: string;
  // Customer accounts assigned to this event (#354). Optional array of
  // customer_accounts.id; backend service diffs against the existing
  // assignments and applies inserts/deletes inside the same transaction.
  customer_account_ids?: number[];
}

interface UpdateEventData {
  event_name?: string;
  event_date?: string;
  customer_name?: string;
  customer_email?: string;
  admin_email?: string;
  require_password?: boolean;
  password?: string;
  welcome_message?: string;
  color_theme?: string;
  expires_at?: string;
  is_active?: boolean;
  allow_user_uploads?: boolean;
  upload_category_id?: number | null;
  hero_photo_id?: number | null;
  source_mode?: 'managed' | 'reference';
  external_path?: string | null;
  photo_cap?: number | null;
  default_photo_sort?: string;
  // Per-event opt-in for hero photo as social-share preview (#474).
  og_image_share_enabled?: boolean;
  // Customer accounts (#354). Same semantics as on CreateEventData;
  // omit the field to leave assignments untouched, send [] to clear.
  customer_account_ids?: number[];
}

export type EventStatusFilter = 'active' | 'inactive' | 'archived' | 'draft' | 'expiring';

interface EventsListResponse {
  events: Event[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export const eventsService = {
  // Get all events (admin)
  async getEvents(
    page: number = 1,
    limit: number = 20,
    status?: EventStatusFilter,
    search?: string
  ): Promise<EventsListResponse> {
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

    const response = await api.get<EventsListResponse>(`/admin/events?${params}`);
    const data: any = response.data;
    if (Array.isArray(data?.events)) {
      data.events = data.events.map((event: Event) => normalizeEvent(event));
    } else if (Array.isArray(data)) {
      return data.map((event: Event) => normalizeEvent(event)) as any;
    }
    return data;
  },

  // Get single event details (admin)
  async getEvent(id: number): Promise<Event> {
    const response = await api.get<Event>(`/admin/events/${id}`);
    return normalizeEvent(response.data as Event);
  },

  // Create new event (admin)
  async createEvent(data: CreateEventData): Promise<Event> {
    const response = await api.post<Event>('/admin/events', data);
    return normalizeEvent(response.data as Event);
  },

  // Update event (admin)
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

  // Extend event expiration (admin)
  async extendExpiration(id: number, days: number): Promise<Event> {
    const response = await api.post<Event>(`/events/${id}/extend`, {
      days,
    });
    return response.data;
  },

  // Get event categories
  async getEventCategories(eventId: number): Promise<Array<{ id: number; name: string; slug: string }>> {
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
    options?: { password?: string },
  ): Promise<{ message: string; is_draft: boolean }> {
    const body = options?.password ? { password: options.password } : undefined;
    const response = await api.post(`/admin/events/${eventId}/publish`, body);
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

  // Get admin preview token (uses existing admin session token)
  getPreviewToken(): string | null {
    const token = sessionStorage.getItem('admin_token') || localStorage.getItem('admin_token');
    return token;
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
};
