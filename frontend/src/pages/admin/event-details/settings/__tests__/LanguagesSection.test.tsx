/**
 * Settings → Languages (issue 2550): choosing a mode fills in sensible
 * languages, the title gets its language tabs only while the mode is on, and
 * the welcome message under General gets the same tabs.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { LanguagesSection } from '../LanguagesSection';
import { GeneralSection } from '../sections';
import { eventFieldsFromEvent, type EventFields } from '../draft';
import type { Event } from '../../../../../types';

vi.mock('../../../../../hooks/usePermission', () => ({ usePermission: () => true }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'de-DE' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('../../../../../components/admin/CustomerAccountPicker', () => ({ CustomerAccountPicker: () => null }));
vi.mock('../../../../../components/admin/TeamMemberPicker', () => ({ TeamMemberPicker: () => null }));

const event = { id: 1, event_name: 'Hochzeit', welcome_message: 'Willkommen' } as unknown as Event;

afterEach(cleanup);

describe('LanguagesSection', () => {
  it('starts off, without tabs', () => {
    render(<LanguagesSection f={eventFieldsFromEvent(event, null)} set={vi.fn()} event={event} texts={{}} setTexts={vi.fn()} />);
    expect((screen.getByLabelText('One language') as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('choosing bilingual picks the admin language first and another one second', () => {
    const set = vi.fn();
    render(<LanguagesSection f={eventFieldsFromEvent(event, null)} set={set} event={event} texts={{}} setTexts={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Two languages together'));
    expect(set).toHaveBeenCalledWith({ text_language_mode: 'bilingual', text_primary_language: 'de', text_secondary_language: 'en' });
  });

  it('bilingual: the title gets a tab per language; the default one is the stored title, read-only', () => {
    const f: EventFields = { ...eventFieldsFromEvent(event, null), text_language_mode: 'bilingual', text_primary_language: 'de', text_secondary_language: 'en' };
    const setTexts = vi.fn();
    render(<LanguagesSection f={f} set={vi.fn()} event={event} texts={{ 'event_name:en': 'Wedding' }} setTexts={setTexts} />);
    const input = screen.getByLabelText('Gallery title') as HTMLInputElement;
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['de', 'en']);
    expect(input.value).toBe('Hochzeit');
    expect(input.readOnly).toBe(true);
    fireEvent.click(screen.getAllByRole('tab')[1]);
    expect(input.value).toBe('Wedding');
    fireEvent.change(input, { target: { value: 'The wedding' } });
    expect(setTexts).toHaveBeenCalledWith({ 'event_name:en': 'The wedding' });
  });
});

describe('GeneralSection welcome message', () => {
  it('edits the default text and each translation in its own tab', () => {
    const f: EventFields = { ...eventFieldsFromEvent(event, null), text_language_mode: 'visitor', text_primary_language: 'de' };
    const set = vi.fn();
    const setTexts = vi.fn();
    render(<GeneralSection f={f} set={set} phoneFieldEnabled={false} event={event} texts={{}} setTexts={setTexts} />);
    const field = screen.getByLabelText('events.welcomeMessageLabel') as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: 'Hallo' } });
    expect(set).toHaveBeenCalledWith({ welcome_message: 'Hallo' });
    fireEvent.click(screen.getByRole('tab', { name: /^en/ }));
    // An empty translation shows the default text as its placeholder.
    expect(field.placeholder).toBe('Willkommen');
    fireEvent.change(field, { target: { value: 'Hello' } });
    expect(setTexts).toHaveBeenCalledWith({ 'welcome_message:en': 'Hello' });
  });

  it('is the plain field while the mode is off', () => {
    render(<GeneralSection f={eventFieldsFromEvent(event, null)} set={vi.fn()} phoneFieldEnabled={false} event={event} texts={{}} setTexts={vi.fn()} />);
    expect(screen.queryByRole('tablist')).toBeNull();
  });
});
