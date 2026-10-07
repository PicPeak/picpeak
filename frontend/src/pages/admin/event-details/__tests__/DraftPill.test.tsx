/**
 * The draft marker explains itself in a tooltip. Hover and keyboard focus are
 * CSS; a click or tap goes through the component's own state, because Safari
 * does not focus a button it clicks. Escape and a click elsewhere close it.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { DraftPill } from '../EventDetailsHeader';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

const pill = () => screen.getByRole('button', { name: 'events.draft: events.draftBanner' });

describe('DraftPill', () => {
  it('starts closed and carries the explanation as its tooltip and label', () => {
    render(<DraftPill />);
    expect(pill()).not.toHaveClass('is-open');
    expect(pill()).toHaveAttribute('data-tooltip', 'events.draftBanner');
  });

  it('opens on click and closes on a second click', () => {
    render(<DraftPill />);
    fireEvent.click(pill());
    expect(pill()).toHaveClass('is-open');
    fireEvent.click(pill());
    expect(pill()).not.toHaveClass('is-open');
  });

  it('closes on Escape', () => {
    render(<DraftPill />);
    fireEvent.click(pill());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(pill()).not.toHaveClass('is-open');
  });

  it('Escape on the focused pill hides the tooltip until focus leaves', () => {
    render(<DraftPill />);
    pill().focus();
    fireEvent.keyDown(pill(), { key: 'Escape' });
    expect(pill()).toHaveClass('is-dismissed');
    fireEvent.blur(pill());
    expect(pill()).not.toHaveClass('is-dismissed');
  });

  it('closes on a click or tap elsewhere, not on one inside', () => {
    render(<div><DraftPill /><p>elsewhere</p></div>);
    fireEvent.click(pill());
    fireEvent.mouseDown(pill());
    expect(pill()).toHaveClass('is-open');
    fireEvent.mouseDown(screen.getByText('elsewhere'));
    expect(pill()).not.toHaveClass('is-open');
    fireEvent.click(pill());
    fireEvent.touchStart(screen.getByText('elsewhere'));
    expect(pill()).not.toHaveClass('is-open');
  });
});
