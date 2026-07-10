import { api } from '../config/api';

export type IdentityMode = 'simple' | 'guest';

export interface FeedbackSettings {
  feedback_enabled: boolean;
  allow_ratings: boolean;
  allow_likes: boolean;
  allow_comments: boolean;
  allow_favorites: boolean;
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
  feedback_type: 'rating' | 'like' | 'comment' | 'favorite';
  rating?: number;
  comment_text?: string;
  comment?: string;
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
  comment_count: number;
}

export interface MyFeedback {
  rating?: number;
  liked: boolean;
  favorited: boolean;
}

export interface FeedbackResponse {
  feedback: PhotoFeedback[];
  summary: FeedbackSummary;
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
    feedback_type: 'rating' | 'like' | 'comment' | 'favorite';
    rating?: number;
    comment_text?: string;
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
