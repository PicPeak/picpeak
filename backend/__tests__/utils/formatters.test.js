/**
 * Unit tests for formatters.js — focused on the HTML-escape behaviour added
 * so admin-supplied welcome messages can't inject markup into customer mail.
 */

const { escapeHtml, nl2br, formatWelcomeMessage } = require('../../src/utils/formatters');

describe('escapeHtml', () => {
  it('escapes the five HTML metacharacters', () => {
    expect(escapeHtml('& < > " \'')).toBe('&amp; &lt; &gt; &quot; &#39;');
  });

  it('returns empty string for null/undefined', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('coerces non-string values', () => {
    expect(escapeHtml(42)).toBe('42');
  });

  it('escapes & before introducing new entities', () => {
    expect(escapeHtml('<&>')).toBe('&lt;&amp;&gt;');
  });
});

describe('nl2br', () => {
  it('joins non-empty lines with <br />', () => {
    expect(nl2br('a\nb\nc')).toBe('a<br />b<br />c');
  });

  it('normalises CRLF and CR', () => {
    expect(nl2br('a\r\nb\rc')).toBe('a<br />b<br />c');
  });

  it('drops empty lines', () => {
    expect(nl2br('a\n\n\nb')).toBe('a<br />b');
  });

  it('returns empty for empty input', () => {
    expect(nl2br('')).toBe('');
    expect(nl2br(null)).toBe('');
  });
});

describe('formatWelcomeMessage', () => {
  it('returns empty string for empty input', () => {
    expect(formatWelcomeMessage('')).toBe('');
    expect(formatWelcomeMessage('   ')).toBe('');
  });

  it('escapes HTML metacharacters before nl2br', () => {
    expect(formatWelcomeMessage('Hello <b>world</b>'))
      .toBe('Hello &lt;b&gt;world&lt;/b&gt;');
  });

  it('renders newlines as <br /> while keeping content escaped', () => {
    expect(formatWelcomeMessage('line 1\n<script>x</script>\nline 3'))
      .toBe('line 1<br />&lt;script&gt;x&lt;/script&gt;<br />line 3');
  });

  it('escapes ampersands and quotes that would otherwise break HTML', () => {
    expect(formatWelcomeMessage('Tom & Jerry\'s "show"'))
      .toBe('Tom &amp; Jerry&#39;s &quot;show&quot;');
  });
});
