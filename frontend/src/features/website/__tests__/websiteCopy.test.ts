/**
 * The website builder's copy, in every language it ships in: a hint that
 * sends the admin to a tab or section names it as the interface does.
 */
import { describe, expect, it } from 'vitest';
import en from '../../../i18n/locales/en.json';
import de from '../../../i18n/locales/de.json';

type Tree = { [key: string]: string | Tree };
const read = (tree: Tree, dotted: string): string => {
  const value = dotted.split('.').reduce<string | Tree | undefined>((node, part) => (node && typeof node === 'object' ? node[part] : undefined), tree);
  if (typeof value !== 'string') throw new Error(`no string at ${dotted}`);
  return value;
};

describe.each([['en', en as unknown as Tree], ['de', de as unknown as Tree]])('website copy (%s)', (_lang, tree) => {
  it('points at the Design tab by the name the tab has', () => {
    const tab = read(tree, 'website.tabs.site');
    expect(read(tree, 'website.pages.orderHint')).toContain(`${tab} › ${read(tree, 'website.menu.title')}`);
    expect(read(tree, 'website.fields.contactNotice')).toContain(`${tab} › ${read(tree, 'website.contact.title')}`);
  });
});
