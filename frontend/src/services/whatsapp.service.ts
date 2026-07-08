import { api } from '../config/api';

/**
 * WhatsApp Business API admin config (#640D). The access token is masked on
 * GET — the server returns `'********'` when a token is stored, the empty
 * string when none is. The PUT silently preserves the stored token if the
 * masked sentinel is sent back unchanged.
 */
// Slot keys that map to the built-in `message_data` fields the queue
// processor knows how to substitute. Order = positional `{{N}}` order in the
// Meta-registered template body. Any other string is dropped server-side.
export type WhatsAppTemplateParam =
  | 'customer_name'
  | 'event_name'
  | 'gallery_link'
  | 'password_line'
  | 'expiry_date';

export const WHATSAPP_TEMPLATE_PARAMS: WhatsAppTemplateParam[] = [
  'customer_name',
  'event_name',
  'gallery_link',
  'password_line',
  'expiry_date',
];

export interface WhatsAppConfig {
  phone_number_id: string;
  waba_id: string;
  access_token: string; // masked '********' on GET when a real token is stored
  template_name: string;
  // Meta template language code (`ar`, `en_US`, `de_DE`, etc.) (#647). Must
  // match the language the operator registered with Meta for `template_name`,
  // otherwise Meta returns template_not_found_in_language (132001). Empty
  // string falls through to general_default_language.
  template_language: string;
  // Ordered slot list controlling which built-in values are sent as
  // positional `{{N}}` parameters to Meta, and in what order (#647
  // follow-up). Empty (server-side) falls back to the legacy 5-slot
  // gallery_ready shape so existing installs keep working unchanged.
  template_params: WhatsAppTemplateParam[];
  enabled: boolean;
}

export const whatsappService = {
  async getConfig(): Promise<WhatsAppConfig> {
    const response = await api.get<WhatsAppConfig>('/admin/whatsapp/config');
    return response.data;
  },

  async updateConfig(config: Partial<WhatsAppConfig>): Promise<{ success: true }> {
    const response = await api.put<{ success: true }>('/admin/whatsapp/config', config);
    return response.data;
  },

  // Sends a static test message to the supplied phone number using the
  // currently-saved config. Returns the Meta message ID on success.
  async sendTest(phone: string): Promise<{ success: boolean; messageId?: string }> {
    const response = await api.post<{ success: boolean; messageId?: string }>(
      '/admin/whatsapp/test',
      { phone },
    );
    return response.data;
  },
};
