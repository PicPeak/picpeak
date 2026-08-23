import { api } from '../config/api';

export type IdentityMode = 'simple' | 'guest';

// Emoji reactions (#839): the fixed curated set. Mirrored in
// backend/src/constants/reactions.js — update both together.
export const REACTION_EMOJIS = ['❤️', '😂', '😍', '👏', '🎉'] as const;
export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];

// Colour labels (#1044): Lightroom's colour set, so a client's proofing
// selection round-trips into the photographer's catalogue through xmp:Label.
// Mirrored in backend/src/constants/colorLabels.js — update both together.
export const COLOR_LABELS = ['red', 'yellow', 'green', 'blue', 'purple'] as const;
export type ColorLabel = (typeof COLOR_LABELS)[number];

/** Which lightbox keyboard scheme a gallery uses. */
export type KeybindMode = 'colors' | 'lightroom';

/**
 * The two keyboard schemes, as data — the gallery lightbox, the admin viewer
 * and the settings preview all read these, so they cannot drift.
 *
 * 'colors'    three keys, no Lightroom knowledge needed (discussion #1027):
 *             1 = 1st choice, 2 = 2nd choice, 3 = rejected.
 * 'lightroom' Lightroom's own defaults: 1-5 stars, 6-9 colours. Lightroom has
 *             no default shortcut for purple and neither do we.
 *
 * In both schemes the same key again clears the value.
 */
export const KEYBIND_SCHEMES: Record<KeybindMode, {
  colors: Record<string, ColorLabel>;
  ratings: Record<string, number>;
}> = {
  colors: {
    colors: { '1': 'green', '2': 'yellow', '3': 'red' },
    ratings: {},
  },
  lightroom: {
    colors: { '6': 'red', '7': 'yellow', '8': 'green', '9': 'blue' },
    ratings: { '1': 1, '2': 2, '3': 3, '4': 4, '5': 5 },
  },
};

/**
 * Swatch colours for the five labels. Deliberately literal hex rather than
 * theme variables: these ARE Lightroom's colours, and a gallery theme must
 * not repaint "green" into something the photographer can't match in their
 * catalogue. Each pairs a fill with a border that stays visible on both a
 * white and a black backdrop.
 */
export const COLOR_LABEL_SWATCHES: Record<ColorLabel, { fill: string; ring: string }> = {
  red: { fill: '#e8493f', ring: '#b3251c' },
  yellow: { fill: '#e8c33f', ring: '#a8871a' },
  green: { fill: '#4caf50', ring: '#2e7d32' },
  blue: { fill: '#3f7fe8', ring: '#1c4fb3' },
  purple: { fill: '#9b59d0', ring: '#6a2f99' },
};

export interface FeedbackSettings {
  feedback_enabled: boolean;
  allow_ratings: boolean;
  allow_likes: boolean;
  allow_comments: boolean;
  allow_favorites: boolean;
  allow_reactions: boolean;
  allow_color_labels: boolean;
  /** Which lightbox shortcut scheme this gallery uses (#1044). */
  keybind_mode?: KeybindMode;
  require_name_email: boolean;
  moderate_comments: boolean;
  show_feedback_to_guests: boolean;
  enable_rate_limiting: boolean;
  rate_limit_window_minutes?: number;
  rate_limit_max_requests?: number;
  identity_mode?: IdentityMode;
  // Per-guest caps (#655). null or 0 = unlimited (preserves current
  // behaviour for installs that haven't enabled the cap). Positive
  // integers are enforced server-side — adds beyond the cap return a
  // structured 403 with `code: 'FAVORITE_LIMIT_REACHED'` /
  // `'LIKE_LIMIT_REACHED'`, surfaced to the guest as a modal.
  max_favorites_per_guest?: number | null;
  max_likes_per_guest?: number | null;
}

export interface PhotoFeedback {
  id: number;
  photo_id: number;
  event_id: number;
  feedback_type: 'rating' | 'like' | 'comment' | 'favorite' | 'reaction' | 'color_label';
  rating?: number;
  comment_text?: string;
  comment?: string;
  reaction?: string;
  color_label?: ColorLabel | null;
  guest_name?: string;
  guest_email?: string;
  is_approved: boolean;
  is_hidden: boolean;
  created_at: string;
  updated_at?: string;
  filename?: string;
  path?: string;
  photo_filename?: string;
  is_mine?: boolean;
}

export interface FeedbackSummary {
  average_rating: number;
  total_ratings: number;
  like_count: number;
  favorite_count: number;
  reaction_count?: number;
  color_label_count?: number;
  comment_count: number;
}

export interface MyFeedback {
  rating?: number;
  liked: boolean;
  favorited: boolean;
  reaction?: string | null;
  color_label?: ColorLabel | null;
}

export interface FeedbackResponse {
  feedback: PhotoFeedback[];
  summary: FeedbackSummary;
  /** Per-emoji tallies for the reaction bar (#839), e.g. { '❤️': 3 }. */
  reactions?: Record<string, number>;
  /** Per-colour tallies (#1044), e.g. { green: 3 }. */
  color_labels?: Partial<Record<ColorLabel, number>>;
  my_feedback: MyFeedback;
  pagination?: {
    page: number;
    per_page: number;
    total: number;
  };
}

export interface FeedbackAnalytics {
  summary: {
    total_feedback: number;
    total_ratings: number;
    average_rating: number;
    total_likes: number;
    total_comments: number;
    total_favorites: number;
    total_reactions?: number;
    pending_moderation: number;
  };
  topRated: Array<{
    id: number;
    filename: string;
    average_rating: number;
    feedback_count: number;
    like_count: number;
  }>;
  mostLiked: Array<{
    id: number;
    filename: string;
    like_count: number;
    average_rating: number;
  }>;
  recentComments: Array<{
    comment_text: string;
    guest_name: string;
    created_at: string;
    filename: string;
  }>;
  timeline: Array<{
    date: string;
    count: number;
    feedback_type: string;
  }>;
}

class FeedbackService {
  // Admin endpoints
  async getEventFeedbackSettings(eventId: string): Promise<FeedbackSettings> {
    const response = await api.get(`/admin/feedback/events/${eventId}/feedback-settings`);
    return response.data;
  }

  async updateEventFeedbackSettings(eventId: string, settings: FeedbackSettings): Promise<FeedbackSettings> {
    const response = await api.put(`/admin/feedback/events/${eventId}/feedback-settings`, settings);
    return response.data;
  }

  async getEventFeedback(eventId: string, params?: {
    type?: string;
    status?: string;
    photoId?: string;
    page?: number;
    limit?: number;
  }) {
    const response = await api.get(`/admin/feedback/events/${eventId}/feedback`, { params });
    return response.data;
  }

  async moderateFeedback(feedbackId: string, action: 'approve' | 'hide' | 'reject') {
    const response = await api.put(`/admin/feedback/feedback/${feedbackId}/${action}`);
    return response.data;
  }

  async deleteFeedback(feedbackId: string) {
    const response = await api.delete(`/admin/feedback/feedback/${feedbackId}`);
    return response.data;
  }

  async getEventFeedbackAnalytics(eventId: string): Promise<FeedbackAnalytics> {
    const response = await api.get(`/admin/feedback/events/${eventId}/feedback-analytics`);
    return response.data;
  }

  // `shape` defaults to 'long' (one row per feedback action) for backward
  // compatibility with anyone scripting against this endpoint. 'pivot' (per
  // #640 #6) returns one row per (photo, guest_identifier) with boolean
  // is_favorited / is_liked plus star_rating + comment. Hidden-by-moderator
  // rows are excluded from the pivot.
  async exportEventFeedback(
    eventId: string,
    format: 'json' | 'csv' = 'json',
    shape: 'long' | 'pivot' = 'long',
  ) {
    const response = await api.get(`/admin/feedback/events/${eventId}/feedback/export`, {
      params: { format, shape },
      responseType: format === 'csv' ? 'blob' : 'json'
    });
    return response.data;
  }

  async getPendingModeration() {
    const response = await api.get('/admin/feedback/feedback/pending-moderation');
    return response.data;
  }

  // Word filter management
  async getWordFilters() {
    const response = await api.get('/admin/feedback/word-filters');
    return response.data;
  }

  async addWordFilter(word: string, severity: string) {
    const response = await api.post('/admin/feedback/word-filters', { word, severity });
    return response.data;
  }

  async updateWordFilter(id: number, updates: { word?: string; severity?: string; is_active?: boolean }) {
    const response = await api.put(`/admin/feedback/word-filters/${id}`, updates);
    return response.data;
  }

  async deleteWordFilter(id: number) {
    const response = await api.delete(`/admin/feedback/word-filters/${id}`);
    return response.data;
  }

  // Guest endpoints
  async getGalleryFeedbackSettings(slug: string): Promise<Partial<FeedbackSettings>> {
    const response = await api.get(`/gallery/${slug}/feedback-settings`);
    return response.data;
  }

  async getPhotoFeedback(slug: string, photoId: string): Promise<FeedbackResponse> {
    const response = await api.get(`/gallery/${slug}/photos/${photoId}/feedback`);
    return response.data;
  }

  async submitFeedback(slug: string, photoId: string, feedback: {
    feedback_type: 'rating' | 'like' | 'comment' | 'favorite' | 'reaction' | 'color_label';
    rating?: number;
    comment_text?: string;
    reaction?: string;
    color_label?: ColorLabel;
    guest_name?: string;
    guest_email?: string;
  }) {
    const response = await api.post(`/gallery/${slug}/photos/${photoId}/feedback`, feedback);
    return response.data;
  }

  async getGalleryFeedbackSummary(slug: string) {
    const response = await api.get(`/gallery/${slug}/feedback-summary`);
    return response.data;
  }

  async getMyFeedback(slug: string) {
    const response = await api.get(`/gallery/${slug}/my-feedback`);
    return response.data;
  }
}

export const feedbackService = new FeedbackService();
