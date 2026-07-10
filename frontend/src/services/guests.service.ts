import { api } from '../config/api';

export interface GuestIdentity {
  id: number;
  name: string;
  email: string | null;
  identifier: string;
}

export interface GuestRegisterResponse {
  guest: GuestIdentity;
  token: string;
}

export interface AdminGuestStats {
  likes: number;
  favorites: number;
  comments: number;
  ratings: number;
  distinct_photos: number;
}

export interface AdminGuest {
  id: number;
  name: string;
  email: string | null;
  created_at: string;
  last_seen_at: string;
  email_verified_at: string | null;
  is_deleted: boolean;
  stats: AdminGuestStats;
}

export interface AdminGuestPhoto {
  id: number;
  filename: string;
  original_filename: string | null;
  type?: string;
  url: string;
  thumbnail_url: string;
}

export interface AdminGuestSelections {
  liked: AdminGuestPhoto[];
  favorited: AdminGuestPhoto[];
  rated: Array<{ photo: AdminGuestPhoto; rating: number }>;
  commented: Array<{ photo: AdminGuestPhoto; comment: string; created_at: string }>;
}

export interface AdminGuestDetail {
  guest: AdminGuest;
  selections: AdminGuestSelections;
}

export interface AggregatePhoto extends AdminGuestPhoto {
  picker_count: number;
}

export interface GuestInvite {
  id: number;
  token: string;
  url: string;
  created_at: string;
  redeemed_at: string | null;
  revoked_at: string | null;
  status: 'pending' | 'redeemed' | 'revoked';
  guest: { id: number; name: string; email: string | null };
}

class GuestsService {
  // ===================================================================
  // Gallery-side (public) — guest identity
  // ===================================================================

  async registerGuest(slug: string, data: { name: string; email?: string }): Promise<GuestRegisterResponse> {
    const response = await api.post(`/gallery/${slug}/guest`, data);
    return response.data;
  }

  async getGuestMe(slug: string): Promise<{ guest: GuestIdentity }> {
    const response = await api.get(`/gallery/${slug}/guest/me`);
    return response.data;
  }

  async forgetMe(slug: string): Promise<{ success: boolean }> {
    const response = await api.delete(`/gallery/${slug}/guest/me`);
    return response.data;
  }

  async requestRecoveryCode(slug: string, email: string): Promise<{ success: boolean }> {
    const response = await api.post(`/gallery/${slug}/guest/recover`, { email });
    return response.data;
  }

  async verifyRecoveryCode(slug: string, email: string, code: string): Promise<GuestRegisterResponse> {
    const response = await api.post(`/gallery/${slug}/guest/verify`, { email, code });
    return response.data;
  }

  async redeemInvite(slug: string, inviteToken: string): Promise<GuestRegisterResponse> {
    const response = await api.post(`/gallery/${slug}/guest/redeem`, { inviteToken });
    return response.data;
  }

  // ===================================================================
  // Admin-side
  // ===================================================================

  async getEventGuests(eventId: number): Promise<{ guests: AdminGuest[] }> {
    const response = await api.get(`/admin/events/${eventId}/guests`);
    return response.data;
  }

  async getGuestDetail(eventId: number, guestId: number): Promise<AdminGuestDetail> {
    const response = await api.get(`/admin/events/${eventId}/guests/${guestId}`);
    return response.data;
  }

  async getAggregatePicks(eventId: number): Promise<{ photos: AggregatePhoto[] }> {
    const response = await api.get(`/admin/events/${eventId}/guests/aggregate`);
    return response.data;
  }

  async deleteGuest(eventId: number, guestId: number): Promise<void> {
    await api.delete(`/admin/events/${eventId}/guests/${guestId}`);
  }

  async mergeGuests(eventId: number, keepId: number, mergeIds: number[]): Promise<void> {
    await api.post(`/admin/events/${eventId}/guests/${keepId}/merge`, { mergeIds });
  }

  async exportGuest(eventId: number, guestId: number, format: 'txt' | 'csv' | 'json'): Promise<Blob> {
    const response = await api.get(`/admin/events/${eventId}/guests/${guestId}/export`, {
      params: { format },
      responseType: 'blob',
    });
    return response.data;
  }

  async exportAllGuests(eventId: number, format: 'txt' | 'csv' | 'json'): Promise<Blob> {
    const response = await api.get(`/admin/events/${eventId}/guests/export-all`, {
      params: { format },
      responseType: 'blob',
    });
    return response.data;
  }

  async listInvites(eventId: number): Promise<{ invites: GuestInvite[] }> {
    const response = await api.get(`/admin/events/${eventId}/guests/invites`);
    return response.data;
  }

  async createInvite(eventId: number, data: { name: string; email?: string }): Promise<{ invite: GuestInvite }> {
    const response = await api.post(`/admin/events/${eventId}/guests/invites`, data);
    return response.data;
  }

  async revokeInvite(eventId: number, inviteId: number): Promise<void> {
    await api.delete(`/admin/events/${eventId}/guests/invites/${inviteId}`);
  }
}

export const guestsService = new GuestsService();
