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

// The German the rest of the interface is written in: ß (not the Swiss ss),
// „…“ for quotations, and the interface's own words for its controls.
describe('website copy (de) wording', () => {
  const strings = (tree: Tree, path = ''): [string, string][] => Object.entries(tree).flatMap(([key, value]) => (
    typeof value === 'string' ? [[`${path}${key}`, value] as [string, string]] : strings(value, `${path}${key}.`)
  ));
  const german = [
    ...strings((de as unknown as Tree).website as Tree, 'website.'),
    ...strings((de as unknown as Tree).websiteNotice as Tree, 'websiteNotice.'),
    ['settings.analytics.websiteForwardHelp', read(de as unknown as Tree, 'settings.analytics.websiteForwardHelp')] as [string, string],
  ];
  const offenders = (pattern: RegExp) => german.filter(([, text]) => pattern.test(text)).map(([key]) => key);

  it('writes ß where German does', () => {
    expect(offenders(/[Ff]usszeile|[Gg]ross(?!o)|[Gg]rösse|ausser|fliesst|mässig|[Ss]trasse|heisst|schliess/)).toEqual([]);
  });

  it('quotes with „…“', () => {
    expect(offenders(/[«»]|“[^„]*”/)).toEqual([]);
  });

  it('uses the interface\'s words: Schaltfläche, one word for a phone, no word-for-word terms, a neutral example address', () => {
    expect(offenders(/Knopf|Knöpfe|Pille|Mauerwerk|Handy|ihreseite\.ch/)).toEqual([]);
    expect(read(de as unknown as Tree, 'website.phone')).toBe('Smartphone');
    expect(read(de as unknown as Tree, 'website.menu.mobile')).toContain('Smartphone');
  });
});
