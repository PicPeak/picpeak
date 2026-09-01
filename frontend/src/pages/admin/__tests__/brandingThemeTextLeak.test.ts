/**
 * ThemeContext.applyTheme() writes the branding theme's `--color-text` as an
 * inline style on <html>, so `body { color: var(--color-text) }` applies
 * everywhere — including the light admin chrome and the light-chromed public
 * legal pages. Any heading that ships without an explicit text-color class
 * therefore renders near-white on white as soon as the install picks a
 * dark-toned branding theme (QA S3 / S4 / S13).
 *
 * Source-inspection guard: every heading on the surfaces that were fixed must
 * declare its own colour rather than inheriting the themed body colour.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

const SRC = path.resolve(__dirname, '../../..');

const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

// Headings must set a colour explicitly. `text-theme` / `text-muted-theme` are
// deliberately NOT accepted — they resolve to the same leaking variables.
const EXPLICIT_COLOR = /\btext-(neutral|white|amber|blue|red|green|primary|accent)\b|\btext-(neutral|amber|blue|red|green|primary)-\d/;

const HEADING_TAG = /<(h[1-4])(\s[^>]*?)?>/gs;

const HEADING_FILES = [
  'pages/admin/settings/SettingsBusinessProfilePage.tsx',
  'pages/admin/settings/CrmSettingsPage.tsx',
  'pages/admin/settings/ReminderTemplatesPage.tsx',
  'pages/public/LegalPage.tsx',
];

describe('branding-theme text colour leak (QA S3 / S4 / S13)', () => {
  it.each(HEADING_FILES)('every heading in %s declares an explicit text colour', (rel) => {
    const source = read(rel);
    const offenders: string[] = [];

    for (const match of source.matchAll(HEADING_TAG)) {
      const attrs = match[2] || '';
      const className = /className="([^"]*)"/.exec(attrs)?.[1] ?? '';
      if (!EXPLICIT_COLOR.test(className)) offenders.push(match[0]);
    }

    expect(offenders).toEqual([]);
  });

  it('gives the LegalPage CMS body an explicit colour instead of the themed body colour', () => {
    const source = read('pages/public/LegalPage.tsx');
    expect(source).toMatch(/className="prose prose-neutral max-w-none text-neutral-\d00"/);
  });

  it('keeps the CMS 404 card surface on the same theme tokens as its text', () => {
    // CMSContentBlock intentionally renders themed text (var(--color-text));
    // the card surface has to follow, because `.card` hardcodes bg-white.
    const source = read('components/common/CMSContentBlock.tsx');
    expect(source).toContain("backgroundColor: 'var(--color-surface)'");
    expect(source).toContain("color: 'var(--color-text)'");
  });
});
