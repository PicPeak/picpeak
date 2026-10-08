import { describe, expect, it, vi } from 'vitest';
import en from '../../i18n/locales/en.json';
import de from '../../i18n/locales/de.json';
import { mailPolicyError, mailPolicyMessage } from '../mailErrors';

describe('mailPolicyError', () => {
  it.each([
    ['MAIL_HOST_FORBIDDEN', 'email.networkPolicyForbidden'],
    ['MAIL_HOST_UNRESOLVED', 'email.networkPolicyUnresolved'],
    ['MAIL_CONFIG_INVALID', 'email.networkPolicyInvalid'],
  ])('translates %s without displaying a server-generated message', (code, key) => {
    const translate = vi.fn((value: string) => `translated:${value}`);
    expect(mailPolicyError({ response: { data: { code, error: 'untrusted message' } } }, translate)).toBe(`translated:${key}`);
    expect(translate).toHaveBeenCalledWith(key);
    // System Health gets the bare code from the queue processor.
    expect(mailPolicyMessage(code, translate)).toBe(`translated:${key}`);
  });

  it.each([null, undefined, new Error('offline'), {}, { response: { data: { code: 'EAUTH' } } }])('leaves existing non-policy error handling unchanged', (error) => {
    const translate = vi.fn();
    expect(mailPolicyError(error, translate)).toBeUndefined();
    expect(translate).not.toHaveBeenCalled();
  });

  it.each([en, de])('provides both policy errors and deployment guidance in each locale', (locale) => {
    expect(locale.email.networkPolicyHelp).toContain('MAIL_PRIVATE_ENDPOINTS');
    expect(locale.email.networkPolicyForbidden).toContain('MAIL_PRIVATE_ENDPOINTS');
    expect(locale.email.networkPolicyInvalid).toContain('MAIL_PRIVATE_ENDPOINTS');
    // A typo is not a policy refusal: no deployment setting fixes it.
    expect(locale.email.networkPolicyUnresolved).toBeTruthy();
    expect(locale.email.networkPolicyUnresolved).not.toContain('MAIL_PRIVATE_ENDPOINTS');
  });
});
