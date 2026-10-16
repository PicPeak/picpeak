/**
 * Settings → Downloads edits the gallery's own watermark text (issue 2095).
 * Empty means the company name from Branding.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { DownloadsSection } from '../DownloadsSection';
import { eventFieldsFromEvent, eventUpdatePayload } from '../draft';
import type { Event } from '../../../../../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : _k), i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

const t = (_key: string, fallback: string) => fallback;
const EVENT = { id: 1, slug: 'g', event_name: 'G', source_mode: 'managed', watermark_text: 'Anna & Ben' } as unknown as Event;

describe('gallery watermark text', () => {
  it('shows the stored text and reports edits', () => {
    const set = vi.fn();
    const f = eventFieldsFromEvent(EVENT, null);
    render(<DownloadsSection f={f} set={set} downloads={null} setDownloads={() => {}} downloadsData={undefined} />);
    const input = screen.getByLabelText('Watermark text') as HTMLInputElement;
    expect(input.value).toBe('Anna & Ben');
    fireEvent.change(input, { target: { value: 'Studio North' } });
    expect(set).toHaveBeenCalledWith({ watermark_text: 'Studio North' });
  });

  it('saves a changed text trimmed, and an emptied one as empty', () => {
    const base = eventFieldsFromEvent(EVENT, null);
    expect(eventUpdatePayload({ ...base, watermark_text: '  Studio North ' }, base, t)).toEqual({ watermark_text: 'Studio North' });
    expect(eventUpdatePayload({ ...base, watermark_text: '' }, base, t)).toEqual({ watermark_text: '' });
    expect(eventUpdatePayload({ ...base }, base, t)).toBeNull();
  });

  it('a gallery without a text starts empty and sends nothing until edited', () => {
    const base = eventFieldsFromEvent({ ...EVENT, watermark_text: null } as unknown as Event, null);
    expect(base.watermark_text).toBe('');
    expect(eventUpdatePayload({ ...base, welcome_message: 'Hi' }, base, t)).toEqual({ welcome_message: 'Hi' });
  });
});
