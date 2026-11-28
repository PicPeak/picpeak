/**
 * The footer in the Design panel (issue 2618): columns of different kinds
 * in their own order, the legal links' place, the copyright line and the
 * background.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { WebsiteDocument, WebsiteFooter } from '../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : (fb as { defaultValue?: string })?.defaultValue ?? k) }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('../../../components/admin/CMSEditor', () => ({
  CMSEditor: ({ content, onChange }: { content: string; onChange: (v: string) => void }) => <textarea aria-label="rich" value={content} onChange={(e) => onChange(e.target.value)} />,
}));

import { FooterSection } from '../FooterSection';

const FOOTER: WebsiteFooter = {
  columns: [{ id: 'brand', kind: 'brand', heading: '' }, { id: 'pages', kind: 'pages', heading: '' }],
  legal: 'column', copyright: '', background: 'default',
};
const DOC = { version: 1, customCss: '', theme: {}, pages: [], menu: { items: [] }, footer: FOOTER } as unknown as WebsiteDocument;

function open() {
  let current = DOC;
  const update = vi.fn((fn: (d: WebsiteDocument) => WebsiteDocument) => { current = fn(current); });
  render(<FooterSection doc={DOC} update={update} readOnly={false} />);
  return () => current.footer;
}

describe('footer section', () => {
  it('lists today\'s columns and adds a contact column', () => {
    const footer = open();
    expect([...document.querySelectorAll('[data-footer-column]')].map((el) => el.textContent)).toEqual(['Company and tagline', 'Pages']);
    fireEvent.change(screen.getByLabelText('New column'), { target: { value: 'contact' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add column' }));
    expect(footer().columns[2]).toMatchObject({ kind: 'contact', heading: '', email: '', phone: '', address: '' });
  });

  it('opens a column\'s form under its own row, with the first field focused', () => {
    open();
    fireEvent.click(screen.getAllByRole('button', { name: /Edit column/ })[1]);
    const heading = screen.getByLabelText('Column heading (optional)');
    const rows = screen.getAllByRole('listitem');
    expect(rows[1].contains(heading)).toBe(true);
    expect(rows[0].contains(heading)).toBe(false);
    expect(document.activeElement).toBe(heading);
  });

  it('moves the legal links to the copyright row and writes its own copyright line', () => {
    const footer = open();
    fireEvent.click(screen.getByRole('button', { name: 'Next to the copyright' }));
    expect(footer().legal).toBe('bottom');
    fireEvent.change(screen.getByLabelText('Copyright line'), { target: { value: '© {year} Studio AG' } });
    expect(footer().copyright).toBe('© {year} Studio AG');
  });

  it('turns the legal links off', () => {
    const footer = open();
    fireEvent.click(screen.getByRole('button', { name: 'Not shown' }));
    expect(footer().legal).toBe('off');
  });
});
