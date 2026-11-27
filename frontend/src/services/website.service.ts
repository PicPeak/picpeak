import { api } from '../config/api';
import type {
  EditorState, ImageRef, WebsiteAsset, WebsiteDocument, WebsiteGallery, WebsitePackage, WebsitePhoto,
} from '../features/website/types';

export interface GalleryQuery {
  page?: number;
  q?: string;
  onWebsite?: boolean;
  ids?: number[];
}

// The most references POST /admin/website/media/resolve takes at once.
const RESOLVE_BATCH = 500;

/** Website builder admin API (issue 2618), /api/admin/website. */
export const websiteService = {
  async getState(): Promise<EditorState> {
    const r = await api.get<EditorState>('/admin/website');
    return r.data;
  },
  async saveDraft(document: WebsiteDocument, revision: number): Promise<EditorState> {
    const r = await api.put<EditorState>('/admin/website/draft', { document, revision });
    return r.data;
  },
  async publish(revision: number): Promise<EditorState> {
    const r = await api.post<EditorState>('/admin/website/publish', { revision });
    return r.data;
  },
  async preview(document: WebsiteDocument, pageId: string, options: { videoAsPoster?: boolean } = {}): Promise<string> {
    const r = await api.post<{ html: string }>('/admin/website/preview', { document, pageId, ...options });
    return r.data.html;
  },
  /** Thumbnail URLs by mediaKey: each image once, in batches the server accepts. */
  async resolveMedia(refs: ImageRef[]): Promise<Record<string, string | null>> {
    const unique = [...new Map(refs.map(({ source, id }) => [mediaKey({ source, id }), { source, id }])).values()];
    const urls: Record<string, string | null> = {};
    for (let i = 0; i < unique.length; i += RESOLVE_BATCH) {
      // One batch at a time: the endpoint does a lookup per batch, and an
      // editor rarely has more than one.
      const r = await api.post<{ urls: Record<string, string | null> }>('/admin/website/media/resolve', {
        refs: unique.slice(i, i + RESOLVE_BATCH),
      });
      Object.assign(urls, r.data.urls);
    }
    return urls;
  },
  /** One page of galleries, newest first; `ids` fetches chosen ones whatever the page. */
  async listGalleries(params: GalleryQuery = {}): Promise<{ galleries: WebsiteGallery[]; hasMore: boolean }> {
    const r = await api.get<{ galleries: WebsiteGallery[]; hasMore: boolean }>('/admin/website/galleries', {
      params: {
        page: params.page,
        q: params.q || undefined,
        onWebsite: params.onWebsite ? '1' : undefined,
        ids: params.ids?.length ? params.ids.join(',') : undefined,
      },
    });
    return r.data;
  },
  async setGalleryOnWebsite(id: number, showOnWebsite: boolean): Promise<void> {
    await api.put(`/admin/website/galleries/${id}`, { showOnWebsite });
  },
  async listGalleryPhotos(id: number, page = 1): Promise<{ photos: WebsitePhoto[]; hasMore: boolean }> {
    const r = await api.get<{ photos: WebsitePhoto[]; hasMore: boolean }>(`/admin/website/galleries/${id}/photos`, { params: { page } });
    return r.data;
  },
  /** One page of uploads, newest first. */
  async listAssets(params: { page?: number; q?: string; kind?: 'image' | 'video' } = {}): Promise<{ assets: WebsiteAsset[]; hasMore: boolean }> {
    const r = await api.get<{ assets: WebsiteAsset[]; hasMore: boolean }>('/admin/website/assets', {
      params: { page: params.page, q: params.q || undefined, kind: params.kind },
    });
    return r.data;
  },
  async uploadAsset(file: File): Promise<WebsiteAsset> {
    const form = new FormData();
    form.append('file', file);
    const r = await api.post<{ asset: WebsiteAsset }>('/admin/website/assets', form);
    return r.data.asset;
  },
  async deleteAsset(id: string): Promise<void> {
    await api.delete(`/admin/website/assets/${id}`);
  },
  async listPackages(): Promise<{ available: boolean; packages: WebsitePackage[] }> {
    const r = await api.get<{ available: boolean; packages: WebsitePackage[] }>('/admin/website/packages');
    return r.data;
  },
};

/** Key of an image in the resolveMedia answer. */
export const mediaKey = (ref: { source: string; id: number | string }) => `${ref.source}:${ref.id}`;
