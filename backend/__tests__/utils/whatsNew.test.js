const { parseWhatsNew } = require('../../src/utils/whatsNew');

describe('parseWhatsNew', () => {
  it('prefers the curated <!-- whatsnew --> block', () => {
    const body = [
      '<!-- whatsnew -->',
      '- Invoice drafts in list',
      '- Bank transfer payments',
      '<!-- /whatsnew -->',
      '',
      '### Features',
      '* **invoices:** something long that should be ignored ([#1](http://x))',
    ].join('\n');
    expect(parseWhatsNew(body)).toEqual(['Invoice drafts in list', 'Bank transfer payments']);
  });

  it('falls back to the Features section, stripping scope + commit links', () => {
    const body = [
      '## [3.73.0-beta.0](http://x) (2026-06-29)',
      '',
      '### Features',
      '',
      '* **dashboard:** revenue tile toggles 365 days ([d1c9e02](http://c))',
      '* **invoices:** surface monthly drafts in the Bills list ([e457656](http://c))',
      '',
      '### Bug Fixes',
      '',
      '* **invoices:** add bank transfer ([e96ef4c](http://c))',
    ].join('\n');
    expect(parseWhatsNew(body)).toEqual([
      'revenue tile toggles 365 days',
      'surface monthly drafts in the Bills list',
    ]);
  });

  it('decodes HTML entities release-please escapes into changelog text', () => {
    const body = '### Features\n* **gallery:** supports A &amp; B &lt;tags&gt; &quot;quoted&quot; ([#1](http://x))';
    expect(parseWhatsNew(body)).toEqual(['supports A & B <tags> "quoted"']);
  });

  it('trims a trailing "— implementation detail" clause to the headline', () => {
    const body = '### Features\n* **gallery:** branded URL shortener — /s/&lt;slug&gt; with OG injection ([#699](http://x))';
    expect(parseWhatsNew(body)).toEqual(['branded URL shortener']);
  });

  it('leaves hyphenated words and dash-free bullets intact', () => {
    const body = '### Features\n* **invoices:** mark-paid now supports bank transfer ([#2](http://x))';
    expect(parseWhatsNew(body)).toEqual(['mark-paid now supports bank transfer']);
  });

  it('excludes Bug Fixes from the fallback', () => {
    const body = '### Features\n* **a:** feature one\n### Bug Fixes\n* **b:** fix one';
    expect(parseWhatsNew(body)).toEqual(['feature one']);
  });

  it('caps at 8 bullets and de-dups', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `- bullet ${i % 9}`);
    const body = `<!-- whatsnew -->\n${lines.join('\n')}\n<!-- /whatsnew -->`;
    const out = parseWhatsNew(body);
    expect(out.length).toBe(8);
    expect(new Set(out).size).toBe(8);
  });

  it('returns [] for empty / non-string input', () => {
    expect(parseWhatsNew('')).toEqual([]);
    expect(parseWhatsNew(null)).toEqual([]);
    expect(parseWhatsNew(undefined)).toEqual([]);
  });
});
