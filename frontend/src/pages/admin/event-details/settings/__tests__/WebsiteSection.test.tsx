/**
 * The website opt-in in the gallery settings (issue 2618): a setting saved
 * with the save bar, in its own "Public website" section, that says what it
 * publishes when the gallery has a password.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Event } from '../../../../../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, fb?: unknown) => (typeof fb === 'string' ? fb : _k), i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('../../../../../hooks/usePermission', () => ({ usePermission: () => true }));

import { dirtySections, eventFieldsFromEvent, eventUpdatePayload } from '../draft';
import { WebsiteSection } from '../WebsiteSection';

const t = (_key: string, fallback: string) => fallback;
const EVENT = {
  id: 1, slug: 'g', event_type: 'wedding', event_name: 'G', event_date: '2026-06-14',
  expires_at: '2026-12-14T00:00:00.000Z', require_password: true, customer_name: 'S', customer_email: 's@example.com',
  color_theme: null, custom_theme_enabled: false, source_mode: 'managed', show_on_website: false,
} as unknown as Event;

describe('website opt-in in the gallery settings', () => {
  it('is a draft field of its own section, sent only when changed', () => {
    const base = eventFieldsFromEvent(EVENT, null);
    expect(base.show_on_website).toBe(false);
    expect(eventUpdatePayload(base, base, t)).toBeNull();
    const draft = { ...base, show_on_website: true };
    expect(eventUpdatePayload(draft, base, t)).toEqual({ show_on_website: true });
    const slice = { event: base, feedback: null, downloads: null, slideshow: null };
    expect(dirtySections({ ...slice, event: draft }, slice)).toEqual(new Set(['website']));
  });

  it('switches the draft and warns about a gallery with a password', () => {
    const set = vi.fn();
    const f = eventFieldsFromEvent(EVENT, null);
    render(<MemoryRouter><WebsiteSection f={{ ...f, show_on_website: true }} set={set} event={EVENT} readOnly={false} /></MemoryRouter>);
    expect(screen.getByText(/the photos you pick for the website are public, although this gallery has a password/)).toBeInTheDocument();
    expect(screen.getByText('Photos from this gallery appear with its watermark; upload images directly for a clean portfolio.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch'));
    expect(set).toHaveBeenCalledWith({ show_on_website: false });
  });
});
