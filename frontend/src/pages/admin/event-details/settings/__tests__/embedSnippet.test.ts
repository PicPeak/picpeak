/**
 * The website embed code (issue 1112) the admin copies: the embed URL in an
 * <iframe>, with the gallery name escaped so a name with quotes or markup
 * cannot break out of the attribute on the photographer's website.
 */
import { describe, expect, it } from 'vitest';
import { embedSnippet } from '../EmbedSection';

const TOKEN = 'b'.repeat(64);

describe('embedSnippet', () => {
  it('frames the embed URL lazily, with fullscreen allowed', () => {
    const code = embedSnippet('https://photos.example', { slug: 'summer-party', event_name: 'Summer Party' }, TOKEN);
    expect(code).toContain(`src="https://photos.example/gallery/summer-party/embed/${TOKEN}"`);
    expect(code).toContain('title="Summer Party"');
    expect(code).toContain('loading="lazy"');
    expect(code).toContain('allow="fullscreen"');
    expect(code).toMatch(/^<iframe [^>]*><\/iframe>$/);
  });

  it('escapes the gallery name inside the attribute', () => {
    const code = embedSnippet('https://photos.example', { slug: 'x', event_name: '"><script>alert(1)</script> & Co' }, TOKEN);
    expect(code).toContain('title="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; Co"');
    expect(code).not.toContain('<script>');
  });
});
