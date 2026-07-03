import { api } from '../config/api';

export interface CMSPage {
  id: number;
  slug: string;
  title_en: string;
  title_de: string;
  content_en: string;
  content_de: string;
  logo_url: string | null;
  use_external_url: boolean;
  external_url: string | null;
  // Footer visibility (#441). True = link rendered in the gallery footer.
  show_in_footer?: boolean;
  updated_at: string;
}

export interface PublicCMSPage {
  title: string;
  content: string;
  slug: string;
  logo_url: string | null;
  use_external_url: boolean;
  external_url: string | null;
  show_in_footer?: boolean;
  updated_at: string;
}

export const cmsService = {
  // Get all CMS pages
  async getPages(): Promise<CMSPage[]> {
    const response = await api.get<CMSPage[]>('/admin/cms/pages');
    return response.data;
  },

  // Get a single CMS page
  async getPage(slug: string): Promise<CMSPage> {
    const response = await api.get<CMSPage>(`/admin/cms/pages/${slug}`);
    return response.data;
  },

  // Update a CMS page
  async updatePage(slug: string, data: Partial<CMSPage>): Promise<CMSPage> {
    const response = await api.put<CMSPage>(`/admin/cms/pages/${slug}`, data);
    return response.data;
  },

  // Get public CMS page (no auth required)
  async getPublicPage(slug: string, lang: string = 'en'): Promise<PublicCMSPage> {
    const response = await api.get<PublicCMSPage>(`/public/pages/${slug}`, {
      params: { lang }
    });
    return response.data;
  },

  // Upload a per-page logo (#324)
  async uploadPageLogo(slug: string, file: File): Promise<{ logo_url: string }> {
    const formData = new FormData();
    formData.append('logo', file);
    const response = await api.post<{ logo_url: string }>(
      `/admin/cms/pages/${slug}/logo`,
      formData,
      { headers: { 'Content-Type': 'multipart/form-data' } }
    );
    return response.data;
  },

  // Clear a per-page logo override (revert to global branding logo).
  async clearPageLogo(slug: string): Promise<void> {
    await api.delete(`/admin/cms/pages/${slug}/logo`);
  }
};