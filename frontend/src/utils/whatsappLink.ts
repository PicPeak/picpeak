/**
 * Click-to-chat links for sending a gallery link through WhatsApp by hand.
 * The admin's own WhatsApp opens with the text filled in; nothing goes
 * through the Business API (that channel only carries approved templates).
 */

export type WhatsAppPhoneStatus = 'empty' | 'ok' | 'national' | 'invalid';

/**
 * A phone number as wa.me wants it: the international number in digits, no
 * `+` or `00`. A number starting with a single 0 is national, and the country
 * it belongs to is not guessed: it comes back without digits, and the caller
 * asks for the international format. E.164 numbers are at most 15 digits.
 */
export const normalizeWhatsAppPhone = (raw: string | null | undefined): { digits: string; status: WhatsAppPhoneStatus } => {
  // "+49 (0)170 …" — the bracketed trunk zero is not dialled from abroad.
  const text = (raw || '').trim().replace(/\(0\)/g, '');
  if (!text) return { digits: '', status: 'empty' };
  let digits = text.replace(/\D/g, '');
  if (!digits) return { digits: '', status: 'invalid' };
  if (text.startsWith('+')) {
    // already international
  } else if (digits.startsWith('00')) {
    digits = digits.slice(2);
  } else if (digits.startsWith('0')) {
    return { digits: '', status: 'national' };
  }
  if (digits.length < 7 || digits.length > 15 || digits.startsWith('0')) {
    return { digits: '', status: 'invalid' };
  }
  return { digits, status: 'ok' };
};

/** wa.me link; without a number WhatsApp lets the sender pick the chat. */
export const buildWhatsAppUrl = (digits: string, text: string): string => {
  const query = `?text=${encodeURIComponent(text)}`;
  return digits ? `https://wa.me/${digits}${query}` : `https://wa.me/${query}`;
};

export interface InviteTemplateValues {
  name?: string | null;
  event?: string | null;
  link?: string | null;
  date?: string | null;
}

/**
 * Fills {{name}}, {{event}}, {{link}} and {{date}}. An empty value takes the
 * comma and space in front of it along, so "Hallo {{name}}," reads "Hallo,"
 * and "Здравствуйте, {{name}}!" reads "Здравствуйте!". Unknown placeholders
 * stay as they are.
 */
export const fillInviteTemplate = (template: string, values: InviteTemplateValues): string =>
  template.replace(/(,? ?)\{\{\s*(name|event|link|date)\s*\}\}/g, (_match, before: string, key: keyof InviteTemplateValues) => {
    const value = (values[key] || '').trim();
    return value ? `${before}${value}` : '';
  });
