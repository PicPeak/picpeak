/**
 * Gallery Folio's nav on a phone (issue 2617): the secondary actions leave
 * the row for the menu below 640 px, and the row can shrink instead of
 * running over the way back to the account. jsdom applies no stylesheets,
 * so these pin the rules in the CSS source.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const css = fs.readFileSync(path.resolve(process.cwd(), 'src/components/gallery/layouts/GalleryFolioLayout.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of `selector` inside `@media (<query>)`, or at the top level without a query. */
function declarations(selector: string, query?: string): string {
  // Every block of that query; a top-level rule sits outside all of them.
  const source = query
    ? css.split(`@media (${query})`).slice(1).map((block) => block.split(/\n}\n/)[0]).join('\n')
    : css.replace(/@media[^{]+\{[\s\S]*?\n}\n/g, '');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`(?:^|[},\\s])${escaped}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? '';
}

describe('Folio nav on a phone', () => {
  it('hides the secondary actions below 640 px and shows them from 640 px', () => {
    expect(declarations('.folio-nav-secondary')).toMatch(/display:\s*none/);
    expect(declarations('.folio-nav-secondary', 'min-width: 640px')).toMatch(/display:\s*inline-flex/);
  });

  it('shows the menu below 640 px only', () => {
    expect(declarations('.folio-nav-more', 'min-width: 640px')).toMatch(/display:\s*none/);
  });

  it('keeps the way back to the account whole and lets the label give way', () => {
    expect(declarations('.folio-nav-back')).toMatch(/flex-shrink:\s*0/);
    expect(declarations('.folio-nav-actions')).not.toMatch(/flex-shrink:\s*0/);
    expect(declarations('.folio-nav-start')).toMatch(/min-width:\s*0/);
  });
});
