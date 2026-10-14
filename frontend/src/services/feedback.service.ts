import { api } from '../config/api';
import { explainFeedbackLock } from '../utils/feedbackLock';
import { FEEDBACK_SUBMITTED_EVENT, namedIdentity } from '../utils/feedbackEvents';
import type { FeedbackSubmittedDetail } from '../utils/feedbackEvents';
import type { PhotoAnnotation } from '../utils/photoAnnotation';

export type IdentityMode = 'simple' | 'guest' | 'shared';

// Emoji reactions (#839): the fixed curated set. Mirrored in
// backend/src/constants/reactions.js — update both together.
export const REACTION_EMOJIS = ['❤️', '😂', '😍', '👏', '🎉'] as const;
export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];

// Colour labels (#1044): Lightroom's colour set, so a client's proofing
// selection round-trips into the photographer's catalogue through xmp:Label.
// Mirrored in backend/src/constants/colorLabels.js — update both together.
export const COLOR_LABELS = ['red', 'yellow', 'green', 'blue', 'purple'] as const;
export type ColorLabel = (typeof COLOR_LABELS)[number];

// Approve / reject per photo (issue 744). Mirrored in
// backend/src/constants/photoDecisions.js — update both together.
export const PHOTO_DECISIONS = ['approved', 'rejected'] as const;
export type PhotoDecision = (typeof PHOTO_DECISIONS)[number];
/** Longest reason a guest can give for a decision (DECISION_REASON_MAX_LENGTH). */
export const DECISION_REASON_MAX_LENGTH = 500;

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
  /** Approve / reject per photo (issue 744). Off unless switched on. */
  allow_decisions?: boolean;
  /** "Finish selection" for guests (issue 1733). Off unless switched on. */
  allow_selection_submit?: boolean;
  /** Drawing on a photo with a comment (issue 1733). Off unless switched on. */
  allow_annotations?: boolean;
  /** Which lightbox shortcut scheme this gallery uses (#1044). */
  keybind_mode?: KeybindMode;
  require_name_email: boolean;
  moderate_comments: boolean;
  show_feedback_to_guests: boolean;
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
  feedback_type: 'rating' | 'like' | 'comment' | 'favorite' | 'reaction' | 'color_label' | 'decision';
  rating?: number;
  comment_text?: string;
  comment?: string;
  reaction?: string;
  color_label?: ColorLabel | null;
  /** On decision rows (issue 744); the reason is in comment_text. */
  decision?: PhotoDecision | null;
  /**
   * The drawing on a comment (issue 1733). Typed unknown on purpose: it is
   * only ever drawn after parseAnnotation (utils/photoAnnotation.ts).
   */
  annotation?: unknown;
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
  approved_count?: number;
  rejected_count?: number;
  comment_count: number;
}

export interface MyFeedback {
  rating?: number;
  liked: boolean;
  favorited: boolean;
  reaction?: string | null;
  color_label?: ColorLabel | null;
  /** The viewer's approve / reject (issue 744) and the reason they gave. */
  decision?: PhotoDecision | null;
  decision_reason?: string | null;
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

/** Most photos one bulk rating request may name. Mirrors the backend cap. */
export const BULK_RATING_MAX_PHOTOS = 200;

export interface BulkRatingResponse {
  success: boolean;
  rating: number;
  results: Array<{
    photo_id: number;
    success: boolean;
    error?: string;
    /** Only when the gallery shows feedback to guests. */
    average_rating?: number;
    total_ratings?: number;
  }>;
}

/** What a guest hands in (issue 1733): their picks, or the edited photos. */
export type SubmissionKind = 'selection' | 'approval';

export interface SelectionSubmission {
  id: number;
  kind: SubmissionKind;
  submitted_at: string;
  item_count: number;
  note: string | null;
}

/** The viewer's own state per kind, from GET /gallery/:slug/selection. */
export interface SelectionState {
  selection: {
    /** Show "x of y selected": a cap is set, or the selection can be handed in. */
    counter: boolean;
    can_submit: boolean;
    /** The feedback types that count as a pick in this gallery. */
    pick_types: Array<'like' | 'favorite'>;
    cap: number | null;
    used: number;
    submission: SelectionSubmission | null;
  };
  approval: {
    can_submit: boolean;
    approved: number;
    rejected: number;
    submission: SelectionSubmission | null;
  };
}

/** A submission as the admin sees it. */
export interface AdminSelectionSubmission extends SelectionSubmission {
  guest_id: number | null;
  guest_name: string | null;
  reopened_at: string | null;
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
    total_color_labels?: number;
    total_approved?: number;
    total_rejected?: number;
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

  async getSelectionSubmissions(eventId: string): Promise<AdminSelectionSubmission[]> {
    const response = await api.get(`/admin/feedback/events/${eventId}/selection-submissions`);
    return response.data.submissions;
  }

  async reopenSelectionSubmission(eventId: string, submissionId: number) {
    const response = await api.post(`/admin/feedback/events/${eventId}/selection-submissions/${submissionId}/reopen`);
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
    feedback_type: 'rating' | 'like' | 'comment' | 'favorite' | 'reaction' | 'color_label' | 'decision';
    rating?: number;
    comment_text?: string;
    reaction?: string;
    color_label?: ColorLabel;
    decision?: PhotoDecision;
    /** Only with feedback_type 'comment' (issue 1733). */
    annotation?: PhotoAnnotation;
    guest_name?: string;
    guest_email?: string;
  }) {
    try {
      const response = await api.post(`/gallery/${slug}/photos/${photoId}/feedback`, feedback);
      window.dispatchEvent(new CustomEvent<FeedbackSubmittedDetail>(FEEDBACK_SUBMITTED_EVENT, {
        detail: { slug, feedback_type: feedback.feedback_type, ...namedIdentity(feedback) },
      }));
      return response.data;
    } catch (error) {
      // A finished selection locks the picks (issue 1733). Said here, once,
      // because most tiles swallow a failed like without a word.
      explainFeedbackLock(error);
      throw error;
    }
  }

  async getSelectionState(slug: string): Promise<SelectionState> {
    const response = await api.get(`/gallery/${slug}/selection`);
    return response.data;
  }

  /**
   * One rating for several photos (issue 1733); 0 clears. The server takes at
   * most BULK_RATING_MAX_PHOTOS ids per request and rates all of them or,
   * when the rating budget does not cover them, none (429).
   */
  async submitBulkRating(slug: string, photoIds: number[], rating: number, identity?: {
    guest_name?: string;
    guest_email?: string;
  }): Promise<BulkRatingResponse> {
    const response = await api.post(`/gallery/${slug}/feedback/bulk`, { photo_ids: photoIds, rating, ...identity });
    // A 200 can rate nothing (every photo hidden or gone since it was picked):
    // only a rating that landed names the visitor.
    if ((response.data as BulkRatingResponse)?.results?.some((r) => r.success)) {
      window.dispatchEvent(new CustomEvent<FeedbackSubmittedDetail>(FEEDBACK_SUBMITTED_EVENT, {
        detail: { slug, feedback_type: 'rating', ...namedIdentity(identity) },
      }));
    }
    return response.data;
  }

  async submitSelection(slug: string, kind: SubmissionKind, note?: string, identity?: {
    guest_name: string;
    guest_email: string;
  }): Promise<SelectionSubmission> {
    const response = await api.post(`/gallery/${slug}/selection/submit`, { kind, note: note || undefined, ...identity });
    return response.data.submission;
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
