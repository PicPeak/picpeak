import { describe, it, expect } from 'vitest';
import { buildWhatsAppUrl, fillInviteTemplate, normalizeWhatsAppPhone } from '../whatsappLink';

describe('normalizeWhatsAppPhone', () => {
  it('keeps the digits of an international number', () => {
    expect(normalizeWhatsAppPhone('+49 170 123-4567')).toEqual({ digits: '491701234567', status: 'ok' });
    expect(normalizeWhatsAppPhone('(+44) 7700 900123')).toEqual({ digits: '447700900123', status: 'ok' });
  });

  it('drops the 00 prefix and the bracketed trunk zero', () => {
    expect(normalizeWhatsAppPhone('0049 170 1234567')).toEqual({ digits: '491701234567', status: 'ok' });
    expect(normalizeWhatsAppPhone('+49 (0)170 1234567')).toEqual({ digits: '491701234567', status: 'ok' });
  });

  it('takes digits without a prefix as international', () => {
    expect(normalizeWhatsAppPhone('491701234567')).toEqual({ digits: '491701234567', status: 'ok' });
  });

  it('does not guess the country of a national number', () => {
    expect(normalizeWhatsAppPhone('0170 1234567')).toEqual({ digits: '', status: 'national' });
  });

  it('reports empty and implausible input', () => {
    expect(normalizeWhatsAppPhone('')).toEqual({ digits: '', status: 'empty' });
    expect(normalizeWhatsAppPhone(null)).toEqual({ digits: '', status: 'empty' });
    expect(normalizeWhatsAppPhone('   ')).toEqual({ digits: '', status: 'empty' });
    expect(normalizeWhatsAppPhone('n/a')).toEqual({ digits: '', status: 'invalid' });
    expect(normalizeWhatsAppPhone('+49 12')).toEqual({ digits: '', status: 'invalid' });
    expect(normalizeWhatsAppPhone('+1234567890123456')).toEqual({ digits: '', status: 'invalid' });
    expect(normalizeWhatsAppPhone('+0170 1234567')).toEqual({ digits: '', status: 'invalid' });
  });
});

describe('buildWhatsAppUrl', () => {
  it('addresses the number and encodes the text', () => {
    expect(buildWhatsAppUrl('491701234567', 'Hallo & „Galerie“: https://x.test/g/a?b=1'))
      .toBe(`https://wa.me/491701234567?text=${encodeURIComponent('Hallo & „Galerie“: https://x.test/g/a?b=1')}`);
  });

  it('leaves the chat to WhatsApp without a number', () => {
    expect(buildWhatsAppUrl('', 'Hi\nthere')).toBe('https://wa.me/?text=Hi%0Athere');
  });
});

describe('fillInviteTemplate', () => {
  const values = { name: 'Anna', event: 'Hochzeit', link: 'https://x.test/g', date: '5. Nov. 2026' };

  it('fills every placeholder', () => {
    expect(fillInviteTemplate('Hallo {{name}}, „{{event}}“ vom {{date}}: {{link}}', values))
      .toBe('Hallo Anna, „Hochzeit“ vom 5. Nov. 2026: https://x.test/g');
  });

  it('drops an empty value with the comma and space before it', () => {
    expect(fillInviteTemplate('Hallo {{name}}, Ihre Galerie: {{link}}', { ...values, name: '' }))
      .toBe('Hallo, Ihre Galerie: https://x.test/g');
    expect(fillInviteTemplate('Здравствуйте, {{name}}! {{link}}', { ...values, name: null }))
      .toBe('Здравствуйте! https://x.test/g');
  });

  it('leaves unknown placeholders and plain text alone', () => {
    expect(fillInviteTemplate('{{password}} {{ link }}', values)).toBe('{{password}} https://x.test/g');
  });
});
