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
});
