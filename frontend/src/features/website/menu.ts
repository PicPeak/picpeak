/**
 * The menu's items and the pages (issue 2618): a new page joins the menu at
 * its end, a removed page leaves it, and the page settings' "Show in the
 * menu" shows or hides the page's item.
 */
import { newId } from './blocks';
import type { MenuItem, WebsiteDocument } from './types';

export const MAX_MENU_ITEMS = 12;

const isPageItem = (item: MenuItem, pageId: string) => item.target.kind === 'page' && item.target.pageId === pageId;
const pointsAt = (item: MenuItem, pageId: string) => (item.target.kind === 'page' || item.target.kind === 'anchor') && item.target.pageId === pageId;

function pageItem(pageId: string): MenuItem {
  return { id: newId(), label: '', hidden: false, target: { kind: 'page', pageId } };
}

export function pageInMenu(doc: WebsiteDocument, pageId: string): boolean {
  return doc.menu.items.some((item) => isPageItem(item, pageId) && !item.hidden);
}

export function setPageInMenu(doc: WebsiteDocument, pageId: string, shown: boolean): WebsiteDocument {
  const items = doc.menu.items;
  if (items.some((item) => isPageItem(item, pageId))) {
    return { ...doc, menu: { ...doc.menu, items: items.map((item) => (isPageItem(item, pageId) ? { ...item, hidden: !shown } : item)) } };
  }
  if (!shown || items.length >= MAX_MENU_ITEMS) return doc;
  return { ...doc, menu: { ...doc.menu, items: [...items, pageItem(pageId)] } };
}

/** The document without a page's menu items (its page and its blocks). */
export function menuWithoutPage(doc: WebsiteDocument, pageId: string): WebsiteDocument['menu'] {
  return { ...doc.menu, items: doc.menu.items.filter((item) => !pointsAt(item, pageId)) };
}
