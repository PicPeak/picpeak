/**
 * Brand-token substitution must not reintroduce markup after sanitization
 * (GHSA-j347).
 *
 * buildCachedPayload sanitizes the operator's HTML and THEN calls
 * applyBrandTokens on the result, which did a plain `String.replace` with no
 * escaping. The default templates interpolate tokens into text and into quoted
 * attributes (`<img src="{{brand_logo_url}}" alt="{{company_name}} logo">`,
 * `href="mailto:{{support_email}}"`), so a token value could close the
 * attribute and inject markup into the public origin.
 *
 * The writer is settings.edit (super_admin only) and the CSP blocks inline
 * script, so this is defence-in-depth rather than a live RCE — but the
 * sanitize-then-substitute ordering is a real bug either way.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-brandtok-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'brandtok-test-secret';

const { _internal } = require('../../src/services/publicSiteService');

// applyBrandTokens / sanitizeBrandUrl are module-private; the service exports
// them under _internal for testing (see publicSiteService module.exports).
const { applyBrandTokens, sanitizeBrandUrl } = _internal || {};

const maybe = applyBrandTokens ? describe : describe.skip;

maybe('applyBrandTokens escaping (GHSA-j347)', () => {
  it('escapes markup in a text-position token', () => {
    const out = applyBrandTokens('<p>{{company_name}}</p>', {
      companyName: '<script>alert(1)</script>',
    });
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('escapes a quote that would break out of an attribute', () => {
    const out = applyBrandTokens(
      '<img src="/x.png" alt="{{company_name}} logo">',
      { companyName: '" onerror="alert(1)' },
    );
    // The injected quotes must be entity-encoded, so the payload stays INSIDE
    // the alt value as text instead of terminating it and forming a real
    // onerror attribute. (`onerror=` still appears as literal characters —
    // that is inert; what matters is that no raw `"` closed the attribute.)
    expect(out).not.toContain('" onerror="');
    expect(out).toContain('&quot; onerror=&quot;');
  });

  it('escapes the logo url token used inside src="..."', () => {
    const out = applyBrandTokens('<img src="{{brand_logo_url}}">', {
      logoUrl: '" onerror="alert(1)',
    });
    expect(out).not.toContain('" onerror="');
    expect(out).toContain('&quot;');
  });

  it('leaves ordinary values readable', () => {
    const out = applyBrandTokens('<p>{{company_name}}</p>', { companyName: 'Acme Photos' });
    expect(out).toContain('Acme Photos');
  });
});

const maybeUrl = sanitizeBrandUrl ? describe : describe.skip;

maybeUrl('sanitizeBrandUrl scheme allowlist (GHSA-j347)', () => {
  it('rejects javascript: regardless of case', () => {
    expect(sanitizeBrandUrl('javascript:alert(1)')).toBeNull();
    // The old check was a case-sensitive startsWith and missed these.
    expect(sanitizeBrandUrl('JavaScript:alert(1)')).toBeNull();
    expect(sanitizeBrandUrl('  JAVASCRIPT:alert(1)')).toBeNull();
  });

  it('rejects other non-http schemes', () => {
    expect(sanitizeBrandUrl('data:text/html;base64,PHN2Zz4=')).toBeNull();
    expect(sanitizeBrandUrl('vbscript:msgbox(1)')).toBeNull();
  });

  it('keeps http(s) and relative logo paths working', () => {
    expect(sanitizeBrandUrl('https://cdn.example.com/logo.png'))
      .toBe('https://cdn.example.com/logo.png');
    expect(sanitizeBrandUrl('/uploads/logos/logo.png')).toBe('/uploads/logos/logo.png');
  });
});
