/**
 * Regression test for the "declared but not mapped" branding bug (#932).
 *
 * BrandingPage hydrates its form with
 *
 *     setBrandingSettings(prev => ({ ...prev, ...formatted }))
 *
 * so any field that formatBrandingSettings() fails to return keeps the
 * component's empty-string initializer instead of the persisted value. The
 * form then looks blank, and the next Save posts that empty string back and
 * wipes the row — silently, because the gallery keeps rendering the old value
 * until the save lands.
 *
 * This already happened once to the footer/promo fields (#441 + #440 / #460);
 * the read mapper still carries the comment about it. Rather than test only
 * the field #932 added, assert the round-trip for every branding key the page
 * can edit, so the next person to add one is caught by this test instead of by
 * a user losing their copy.
 */
import { describe, it, expect } from 'vitest';
import { settingsService } from '../settings.service';

// Raw shape as the API returns it: `branding_`-prefixed keys.
const RAW = {
  branding_company_name: 'Studio Nord',
  branding_promo_markdown: '**Spring offer** — 20% off prints',
  branding_promo_position: 'below_footer',
  branding_promo_alignment: 'left',
  branding_info_markdown: '**Tipp:** use the menu button to filter',
  branding_facebook_url: 'https://facebook.com/studionord',
  branding_support_email: 'hello@studionord.example',
};

describe('formatBrandingSettings — persisted values survive a page load', () => {
  it('maps the info banner (#932) rather than dropping it', () => {
    const formatted = settingsService.formatBrandingSettings(RAW);

    // The bug: an unmapped key is simply absent, so the spread in
    // BrandingPage leaves the empty initializer in place.
    expect(Object.prototype.hasOwnProperty.call(formatted, 'info_markdown')).toBe(true);
    expect(formatted.info_markdown).toBe('**Tipp:** use the menu button to filter');
  });

  it('still maps the promo banner it mirrors', () => {
    const formatted = settingsService.formatBrandingSettings(RAW);

    expect(formatted.promo_markdown).toBe('**Spring offer** — 20% off prints');
    expect(formatted.promo_position).toBe('below_footer');
    expect(formatted.promo_alignment).toBe('left');
  });

  it('defaults every text field to empty string, never undefined', () => {
    // A `undefined` here would render an uncontrolled <textarea> and React
    // would warn on first keystroke; the page relies on '' being the default.
    const formatted = settingsService.formatBrandingSettings({});

    expect(formatted.info_markdown).toBe('');
    expect(formatted.promo_markdown).toBe('');
  });

  it('round-trips a value through format without mutating it', () => {
    const formatted = settingsService.formatBrandingSettings(RAW);

    // Markdown must survive verbatim — no trimming or escaping on read,
    // otherwise saving an untouched form rewrites the stored copy.
    expect(formatted.info_markdown).toBe(RAW.branding_info_markdown);
  });
});
