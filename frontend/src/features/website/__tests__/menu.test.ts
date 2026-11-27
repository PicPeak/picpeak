/**
 * The menu follows the pages where it should (issue 2618): a new page joins
 * it, a removed page leaves it, "Show in the menu" hides or shows the item.
 */
import { describe, expect, it } from 'vitest';
import { menuWithoutPage, pageInMenu, setPageInMenu } from '../menu';
import type { WebsiteDocument } from '../types';

const doc = {
  pages: [{ id: 'home' }, { id: 'about' }],
  menu: { items: [
    { id: 'a', label: '', hidden: false, target: { kind: 'page', pageId: 'home' } },
    { id: 'b', label: 'Write', hidden: false, target: { kind: 'anchor', pageId: 'about', blockId: 'form' } },
    { id: 'c', label: '', hidden: false, target: { kind: 'page', pageId: 'about' } },
  ] },
} as unknown as WebsiteDocument;

describe('menu and pages', () => {
  it('hides and shows a page\'s item, and adds one for a page without', () => {
    const hidden = setPageInMenu(doc, 'about', false);
    expect(pageInMenu(hidden, 'about')).toBe(false);
    expect(hidden.menu.items.find((i) => i.id === 'c')?.hidden).toBe(true);
    expect(pageInMenu(setPageInMenu(hidden, 'about', true), 'about')).toBe(true);
    const added = setPageInMenu(doc, 'new', true);
    expect(added.menu.items.at(-1)).toMatchObject({ label: '', hidden: false, target: { kind: 'page', pageId: 'new' } });
  });

  it('drops the items of a removed page, its blocks too', () => {
    expect(menuWithoutPage(doc, 'about').items.map((i) => i.id)).toEqual(['a']);
  });
});
