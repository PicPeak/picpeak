/**
 * Website embed (issue 1112): the two public reads of the embed page. Both
 * answer 404 once the embed is removed, the gallery stops being public or
 * the feature is turned off.
 */
import { api } from '../config/api';

export interface EmbedInfo {
  event: { event_name: string; color_theme?: unknown };
  gallery_path: string;
}

export interface EmbedPhoto {
  id: number;
  width: number | null;
  height: number | null;
  thumbnail_url: string;
  preview_url: string;
}

export interface EmbedPhotoPage {
  pagination: { page: number; limit: number; total: number; has_more: boolean };
  photos: EmbedPhoto[];
}

const base = (slug: string, token: string) =>
  `/gallery/${encodeURIComponent(slug)}/embed/${encodeURIComponent(token)}`;

export const embedService = {
  async getInfo(slug: string, token: string): Promise<EmbedInfo> {
    const response = await api.get<EmbedInfo>(base(slug, token));
    return response.data;
  },

  async getPhotos(slug: string, token: string, page: number): Promise<EmbedPhotoPage> {
    const response = await api.get<EmbedPhotoPage>(`${base(slug, token)}/photos`, { params: { page } });
    return response.data;
  },
};
