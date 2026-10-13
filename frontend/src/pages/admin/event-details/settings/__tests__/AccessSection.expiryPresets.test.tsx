/**
 * Settings → Access: quick picks under the expiry date (issue 1733). A pick
 * fills the date with today + N days, "Never" empties it (stored as "never
 * expires"), and the pick matching the date shows as chosen. The date field
 * stays for anything else.
 */
import React, { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { addDays, format as dateFnsFormat } from 'date-fns';

import { AccessSection } from '../sections';
import { eventFieldsFromEvent, type EventFields } from '../draft';
import type { Event } from '../../../../../types';

vi.mock('../../../../../hooks/usePermission', () => ({ usePermission: () => true }));
vi.mock('../../../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({ format: (d: Date, f?: string) => dateFnsFormat(d, f || 'PP'), dateFormat: 'yyyy-MM-dd' }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown, opts?: { days?: number }) =>
      (typeof fallback === 'string' ? fallback.replace('{{days}}', String(opts?.days)) : key),
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

const inDays = (days: number) => dateFnsFormat(addDays(new Date(), days), 'yyyy-MM-dd');

let latest: EventFields;
const Harness: React.FC<{ expiresAt: string | null }> = ({ expiresAt }) => {
  const [f, setF] = useState(() => eventFieldsFromEvent({ id: 1, expires_at: expiresAt, require_password: false } as unknown as Event, null));
  latest = f;
  return <AccessSection f={f} set={(patch) => setF((prev) => ({ ...prev, ...patch }))} />;
};

const picks = () => within(screen.getByRole('group', { name: 'Expiry quick picks' }));
const pick = (name: string) => picks().getByRole('button', { name });
const pressed = () => picks().getAllByRole('button').filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent);

describe('AccessSection — expiry quick picks', () => {
  it('fills the date with today + N days and marks that pick as chosen', () => {
    render(<Harness expiresAt={`${inDays(10)}T12:00:00.000Z`} />);
    expect(pressed()).toEqual([]);

    fireEvent.click(pick('60 days'));
    expect(latest.expires_at).toBe(inDays(60));
    expect(pressed()).toEqual(['60 days']);

    fireEvent.click(pick('90 days'));
    expect(latest.expires_at).toBe(inDays(90));
    expect(pressed()).toEqual(['90 days']);
  });

  it('"Never" empties the date, and a gallery without one shows it as chosen', () => {
    render(<Harness expiresAt={`${inDays(30)}T12:00:00.000Z`} />);
    fireEvent.click(pick('Never'));
    expect(latest.expires_at).toBe('');
    expect(pressed()).toEqual(['Never']);
  });

  it('shows "Never" as chosen for a gallery that has no expiry', () => {
    render(<Harness expiresAt={null} />);
    expect(pressed()).toEqual(['Never']);
  });

  // The date field keeps its own text while it is being typed in. A pick that
  // equals the stored value changes nothing upstream, and still has to replace
  // what was left half typed.
  it('replaces a half-typed date when the pick already chosen is clicked again', () => {
    render(<Harness expiresAt={`${inDays(60)}T12:00:00.000Z`} />);
    const field = () => screen.getByPlaceholderText('yyyy-mm-dd') as HTMLInputElement;
    expect(pressed()).toEqual(['60 days']);

    fireEvent.change(field(), { target: { value: '2026-1' } });
    fireEvent.blur(field());
    expect(field().value).toBe('2026-1');

    fireEvent.click(pick('60 days'));
    expect(field().value).toBe(inDays(60));
    expect(latest.expires_at).toBe(inDays(60));
  });

  it('clears a half-typed date when "Never" is already chosen and clicked again', () => {
    render(<Harness expiresAt={null} />);
    const field = () => screen.getByPlaceholderText('yyyy-mm-dd') as HTMLInputElement;

    fireEvent.change(field(), { target: { value: '2026-1' } });
    fireEvent.blur(field());
    expect(pressed()).toEqual(['Never']);

    fireEvent.click(pick('Never'));
    expect(field().value).toBe('');
    expect(latest.expires_at).toBe('');
  });
});
