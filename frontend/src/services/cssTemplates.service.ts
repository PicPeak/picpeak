import { api } from '../config/api';

export interface CssTemplate {
  id: number;
  slot_number: number;
  name: string;
  css_content: string;
  is_enabled: boolean;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface CssTemplateUpdate {
  name?: string;
  css_content?: string;
  is_enabled?: boolean;
}

export interface EnabledTemplate {
  id: number;
  name: string;
  slot_number: number;
}

class CssTemplatesService {
  /**
   * Get all CSS templates
   */
  async getTemplates(): Promise<CssTemplate[]> {
    const response = await api.get('/admin/css-templates');
    return response.data.templates;
  }

  /**
   * Get a specific template by slot number
   */
  async getTemplate(slotNumber: number): Promise<CssTemplate> {
    const response = await api.get(`/admin/css-templates/${slotNumber}`);
    return response.data.template;
  }

  /**
   * Get only enabled templates (for event form dropdown)
   */
  async getEnabledTemplates(): Promise<EnabledTemplate[]> {
    const response = await api.get('/admin/css-templates/enabled');
    return response.data.templates;
  }

  /**
   * Update a template
   */
  async updateTemplate(
    slotNumber: number,
    updates: CssTemplateUpdate
  ): Promise<{ template: CssTemplate; warnings: string[] }> {
    const response = await api.put(`/admin/css-templates/${slotNumber}`, updates);
    return {
      template: response.data.template,
      warnings: response.data.sanitization_warnings || []
    };
  }

  /**
   * Reset template 1 to default
   */
  async resetToDefault(): Promise<CssTemplate> {
    const response = await api.post('/admin/css-templates/1/reset');
    return response.data.template;
  }

  /**
   * Get CSS template for a gallery (public endpoint)
   */
  async getGalleryCss(slug: string): Promise<string | null> {
    try {
      const response = await api.get(`/gallery/${slug}/css-template`, {
        responseType: 'text',
        headers: {
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        },
        params: {
          _t: Date.now() // Cache-busting parameter
        }
      });
      if (response.status === 204) {
        return null;
      }
      return response.data;
    } catch (error) {
      console.error('Failed to load gallery CSS:', error);
      return null;
    }
  }
}

export const cssTemplatesService = new CssTemplatesService();
