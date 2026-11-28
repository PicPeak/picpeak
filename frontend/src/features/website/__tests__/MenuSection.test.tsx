/**
 * The menu in the Design panel (issue 2618): its own order (drag, up and
 * down), per item a label, show or hide and a target, items that are not
 * pages, and its design.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { WebsiteDocument, WebsiteMenu } from '../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, fb?: unknown, o?: Record<string, string>) => {
    const text = typeof fb === 'string' ? fb : (fb as { defaultValue?: string })?.defaultValue ?? k;
    const vars = (typeof fb === 'object' ? fb : o) as Record<string, string> | undefined;
    return vars ? text.replace(/\{\{(\w+)\}\}/g, (_, n) => vars[n] ?? '') : text;
  } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

import { MenuSection } from '../MenuSection';

const MENU: WebsiteMenu = {
  layout: 'left', style: 'plain', sticky: true, transparent: false, mobile: 'dropdown', background: null, text: null,
  items: [
    { id: 'home', label: '', hidden: false, target: { kind: 'page', pageId: 'home' } },
    { id: 'about', label: 'Studio', hidden: false, target: { kind: 'page', pageId: 'about' } },
  ],
};
const page = (id: string, title: string) => ({ id, slug: id, title, navLabel: '', hidden: false, isHome: id === 'home', seo: { title: '', description: '', image: null }, blocks: [] });
const DOC = { version: 1, customCss: '', theme: {}, menu: MENU, pages: [page('home', 'Home'), page('about', 'About')] } as unknown as WebsiteDocument;

function open(doc = DOC) {
  let current = doc;
  const update = vi.fn((fn: (d: WebsiteDocument) => WebsiteDocument) => { current = fn(current); });
  render(<MenuSection doc={doc} update={update} readOnly={false} />);
  return { update, menu: () => current.menu };
}

describe('menu section', () => {
  it('lists the items in the menu\'s order with the label they show', () => {
    open();
    expect([...document.querySelectorAll('[data-menu-label]')].map((el) => el.textContent)).toEqual(['Home', 'Studio']);
  });

  it('moves an item without touching the page order', () => {
    const { menu } = open();
    fireEvent.click(screen.getAllByRole('button', { name: /Move .* down/ })[0]);
    expect(menu().items.map((i) => i.id)).toEqual(['about', 'home']);
  });

  it('hides an item and adds one that is not a page', () => {
    const { menu } = open();
    fireEvent.click(screen.getAllByRole('button', { name: /Edit menu item/ })[0]);
    fireEvent.click(screen.getByRole('switch', { name: 'Shown in the menu' }));
    expect(menu().items[0].hidden).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Add menu item' }));
    expect(menu().items[2]).toMatchObject({ label: '', hidden: false, target: { kind: 'url', url: '' } });
  });

  it('opens an item\'s form under its own row, with the first field focused', () => {
    open();
    fireEvent.click(screen.getAllByRole('button', { name: /Edit menu item/ })[1]);
    const label = screen.getByLabelText('Label');
    const rows = screen.getAllByRole('listitem');
    expect(rows[1].contains(label)).toBe(true);
    expect(rows[0].contains(label)).toBe(false);
    expect(document.activeElement).toBe(label);
  });

  it('says what happens to a menu item without a block, not to a button', () => {
    const Holder = () => {
      const [doc, setDoc] = React.useState(DOC);
      return <MenuSection doc={doc} update={(fn) => setDoc(fn)} readOnly={false} />;
    };
    render(<Holder />);
    fireEvent.click(screen.getAllByRole('button', { name: /Edit menu item/ })[0]);
    fireEvent.change(screen.getByLabelText('Leads to'), { target: { value: 'anchor' } });
    expect(screen.getByText('Choose a block, or the item is not shown in the menu.')).toBeInTheDocument();
    expect(screen.queryByText(/the button is not shown/)).toBeNull();
  });

  it('shows the interface\'s focus ring on the drag handle and the move buttons', () => {
    open();
    const buttons = [...screen.getAllByRole('button', { name: /^Move / })];
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) expect(button.className).toContain('focus-visible:ring-2');
  });

  it('sets the design', () => {
    const { menu } = open();
    fireEvent.click(screen.getByRole('button', { name: 'Logo centred' }));
    expect(menu().layout).toBe('center');
    fireEvent.click(screen.getByRole('switch', { name: /Stays at the top/ }));
    expect(menu().sticky).toBe(false);
  });
});
