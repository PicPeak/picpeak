/**
 * The palette is a modal dialog, so Tab must not step out of it into the page
 * behind — which is still fully rendered and fully interactive.
 *
 * This is the activedescendant pattern: the input keeps focus and
 * `aria-activedescendant` names the active option, so the options are
 * deliberately `tabIndex={-1}`. A trap that collects them anyway is worse than
 * no trap, because it moves focus onto a node that cannot be tabbed to and
 * whose keystrokes never reach the handler bound to the input.
 */
import React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { LayoutDashboard } from 'lucide-react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : k) }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('../../../contexts/UnsavedChangesContext', () => ({
  useLeaveGuard: () => ({ confirmLeave: async () => true, isAnyDirty: false }),
}));
vi.mock('../adminSearchIndex', () => ({
  useAdminSearchIndex: () => [
    { key: 'a', label: 'Dashboard', href: '/admin/dashboard', icon: LayoutDashboard, group: 'Pages' },
    { key: 'b', label: 'Events', href: '/admin/events', icon: LayoutDashboard, group: 'Pages' },
  ],
}));

import { CommandPalette } from '../CommandPalette';

// jsdom implements no layout, so it has no scrollIntoView. Real browsers do;
// the component keeps the highlighted row in view with it.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

const open = () => render(
  <MemoryRouter><CommandPalette isOpen onClose={() => {}} /></MemoryRouter>,
);

afterEach(cleanup);

describe('command palette focus handling', () => {
  it('keeps Tab inside the dialog', () => {
    open();
    const input = screen.getByRole('combobox');
    input.focus();

    const forward = fireEvent.keyDown(input, { key: 'Tab' });
    // fireEvent returns false when a handler called preventDefault.
    expect(forward).toBe(false);
    expect(document.activeElement).toBe(input);

    const back = fireEvent.keyDown(input, { key: 'Tab', shiftKey: true });
    expect(back).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  it('never parks focus on a result, which cannot be tabbed to', () => {
    open();
    const input = screen.getByRole('combobox');
    input.focus();
    fireEvent.keyDown(input, { key: 'Tab' });

    const options = screen.getAllByRole('option');
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      expect(option).toHaveAttribute('tabindex', '-1');
      expect(document.activeElement).not.toBe(option);
    }
  });

  it('leaves Escape, the arrows and Enter of an IME composition to the search field', () => {
    const onClose = vi.fn();
    render(<MemoryRouter><CommandPalette isOpen onClose={onClose} /></MemoryRouter>);
    const input = screen.getByRole('combobox');
    input.focus();
    const active = () => input.getAttribute('aria-activedescendant');
    const before = active();
    for (const flags of [{ isComposing: true }, { keyCode: 229 }]) {
      fireEvent.keyDown(input, { key: 'ArrowDown', ...flags });
      fireEvent.keyDown(input, { key: 'Enter', ...flags });
      fireEvent.keyDown(input, { key: 'Escape', ...flags });
    }
    expect(onClose).not.toHaveBeenCalled();
    expect(active()).toBe(before);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('puts the option role on the clickable element, not a wrapper', () => {
    open();
    for (const option of screen.getAllByRole('option')) {
      expect(option.tagName).toBe('BUTTON');
    }
  });

  it('only points aria-controls at a list that exists', () => {
    open();
    const input = screen.getByRole('combobox');
    expect(input).toHaveAttribute('aria-controls', 'command-palette-results');

    fireEvent.change(input, { target: { value: 'zzzznothing' } });
    expect(input).not.toHaveAttribute('aria-controls');
    expect(input).toHaveAttribute('aria-expanded', 'false');
  });
});
