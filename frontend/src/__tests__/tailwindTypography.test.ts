/**
 * The `prose` classes must actually resolve to CSS (#1288).
 *
 * Tailwind's Preflight resets h1-h6 to inherit size and weight, and strips
 * list-style and padding from ul/ol. Ten places in this app render rich text
 * in a `prose` container and depend on @tailwindcss/typography to put that
 * back. With the plugin missing, every `prose*` class is a no-op — so applying
 * a heading or a list in the CMS editor changed the document and changed
 * nothing on screen. The toolbar button lit up (the editor state was right)
 * while the text stayed visually a paragraph, which is why it read as "the
 * formatting buttons do nothing".
 *
 * A missing plugin produces no error and no warning — the class simply does
 * not exist — so a config guard is the only cheap place to notice.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const root = resolve(__dirname, '../..');

describe('tailwind typography plugin (#1288)', () => {
  const config = readFileSync(resolve(root, 'tailwind.config.js'), 'utf8');

  it('is registered in the tailwind config', () => {
    expect(config).toMatch(/require\(['"]@tailwindcss\/typography['"]\)/);
  });

  it('is a declared dependency', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(deps['@tailwindcss/typography']).toBeDefined();
  });

  it('actually resolves, rather than just being named in the config', async () => {
    const plugin = await import('@tailwindcss/typography');
    expect(plugin.default).toBeDefined();
  });

  describe('theme-owned prose colours', () => {
    const overrides = readFileSync(resolve(root, 'src/styles/prose-overrides.css'), 'utf8');

    // The plugin ships a fixed near-black palette and sets `color` on the
    // heading ELEMENT, which beats the container's inherited colour. A dark
    // gallery preset writes a near-white --color-text on :root and does NOT
    // add a `.dark` class, so `dark:prose-invert` never engages — without
    // this mapping the promo block, info banner and public CMS pages render
    // near-black headings on a dark background.
    it('remaps the prose palette wherever the theme owns the text colour', () => {
      expect(overrides).toMatch(/\.prose\.text-theme\s*\{/);
      expect(overrides).toMatch(/--tw-prose-headings:\s*var\(--color-text\)/);
      expect(overrides).toMatch(/--tw-prose-body:\s*var\(--color-text\)/);
      expect(overrides).toMatch(/--tw-prose-bold:\s*var\(--color-text\)/);
    });

    it('keeps the gallery prose surfaces carrying the text-theme marker', () => {
      // The mapping is keyed on that class; a consumer that drops it silently
      // falls back to the near-black palette.
      for (const file of [
        'src/components/gallery/GalleryLayout.tsx',
        'src/components/common/CMSContentBlock.tsx',
      ]) {
        const src = readFileSync(resolve(root, file), 'utf8');
        const proseLines = src.split('\n').filter((l) => /className|class=/.test(l) && /\bprose\b/.test(l));
        expect(proseLines.length).toBeGreaterThan(0);
        for (const line of proseLines) {
          expect(line).toMatch(/text-theme/);
        }
      }
    });
  });
});
