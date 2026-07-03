import { api } from '../config/api';

export interface GalleryShortUrl {
  id: number;
  short_slug: string;
  target_path: string;
  hit_count: number;
  last_hit_at: string | null;
  created_at: string;
  created_by: number | null;
}

/**
 * Branded URL shortener (#699). Each event can have multiple short URLs
 * pointing at it; the public route lives at `/s/<short_slug>` and is
 * bot-UA aware (serves OG to scrapers, 302 to browsers).
 */
export const shortUrlsService = {
  async listForEvent(eventId: number): Promise<GalleryShortUrl[]> {
    const { data } = await api.get(`/admin/events/${eventId}/short-urls`);
    return data?.shortUrls ?? [];
  },

  /**
   * Create a short URL for an event. `customSlug` is optional — omit to
   * let the backend auto-generate from the event's slug + year.
   *
   * Surfaces structured errors:
   *   - 400 INVALID_SLUG  → bad shape (letters/digits/hyphens, 1-64 chars)
   *   - 409 SLUG_TAKEN    → another live row holds the slug; the response
   *                         body includes `suggested` with an available
   *                         alternative the caller can pre-fill in the
   *                         input on retry.
   */
  async create(
    eventId: number,
    customSlug?: string,
  ): Promise<GalleryShortUrl> {
    const body = customSlug ? { customSlug } : {};
    const { data } = await api.post(`/admin/events/${eventId}/short-urls`, body);
    return data;
  },

  async remove(id: number): Promise<void> {
    await api.delete(`/admin/short-urls/${id}`);
  },
};
