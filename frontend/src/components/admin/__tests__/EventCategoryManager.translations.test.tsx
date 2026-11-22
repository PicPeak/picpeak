/**
 * Category names and chapter markers in other languages (issue 2550), per
 * gallery: the language tabs appear only while the gallery's mode is on, the
 * default tab is the stored text, and saving writes only what changed.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mocks = vi.hoisted(() => ({
  getEventCategories: vi.fn(),
  updateChapter: vi.fn(),
  getTranslations: vi.fn(),
  saveTranslations: vi.fn(),
}));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, fallback?: unknown, opts?: Record<string, unknown>) => {
      const text = typeof fallback === 'string' ? fallback : key;
      return opts ? text.replace(/\{\{(\w+)\}\}/g, (_, k) => String(opts[k])) : text;
    },
    i18n: { language: 'en' },
  }),
}));
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../services/categories.service', () => ({
  categoriesService: {
    getEventCategories: mocks.getEventCategories,
    updateChapter: mocks.updateChapter,
  },
}));
vi.mock('../../../services/photos.service', () => ({ photosService: { getEventPhotos: vi.fn().mockResolvedValue({ photos: [] }) } }));
vi.mock('../../../services/translations.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/translations.service')>()),
  translationsService: { get: mocks.getTranslations, save: mocks.saveTranslations },
}));
vi.mock('../../common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../common')>()),
  AuthenticatedImage: () => null,
  useConfirm: () => vi.fn(),
}));

import { EventCategoryManager } from '../EventCategoryManager';

const category = {
  id: 9, name: 'Trauung', slug: 'trauung', is_global: false, event_id: 4,
  chapter_heading: 'Die Trauung', chapter_subheading: null, chapter_time: '12:00', chapter_location: 'Standesamt',
  chapter_available: true,
};

function state(mode: 'off' | 'visitor' | 'bilingual') {
  return {
    text_language_mode: mode, text_primary_language: mode === 'off' ? null : 'de',
    text_secondary_language: mode === 'bilingual' ? 'en' : null,
    languages: ['en', 'de', 'es', 'fr', 'nl', 'pt', 'ru', 'sl'],
    translations: [
      { entity_type: 'category', entity_id: 9, field: 'name', language: 'en', text: 'Ceremony' },
      { entity_type: 'chapter', entity_id: 9, field: 'heading', language: 'en', text: 'Wedding ceremony' },
    ],
  };
}

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><EventCategoryManager eventId={4} /></QueryClientProvider>);
}

beforeEach(() => {
  mocks.getEventCategories.mockResolvedValue([category]);
  mocks.updateChapter.mockResolvedValue({});
  mocks.saveTranslations.mockResolvedValue(state('bilingual'));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('EventCategoryManager translations', () => {
  it('offers no language tools while the mode is off', async () => {
    mocks.getTranslations.mockResolvedValue(state('off'));
    show();
    await screen.findByText('Trauung');
    expect(screen.queryByRole('button', { name: 'Name in other languages' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Chapter marker' }));
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('saves a changed name translation and leaves the others alone', async () => {
    mocks.getTranslations.mockResolvedValue(state('visitor'));
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Name in other languages' }));
    const tabs = screen.getAllByRole('tab');
    // The default tab first, then every other UI language.
    expect(tabs.map((tab) => tab.textContent)).toEqual(['de', 'en', 'ru', 'pt', 'nl', 'fr', 'es', 'sl']);
    const tab = (code: string) => tabs.find((el) => el.textContent === code)!;
    const input = screen.getByLabelText('Category name') as HTMLInputElement;
    // The default tab is the stored name, read-only here.
    expect(input.value).toBe('Trauung');
    expect(input.readOnly).toBe(true);
    fireEvent.click(tab('en'));
    expect(input.value).toBe('Ceremony');
    fireEvent.click(tab('fr'));
    fireEvent.change(input, { target: { value: 'Cérémonie' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() => expect(mocks.saveTranslations).toHaveBeenCalledWith(4, [
      { entity_type: 'category', entity_id: 9, field: 'name', language: 'fr', text: 'Cérémonie' },
    ]));
  });

  it('a chapter saved after the translations arrive late deletes none of them', async () => {
    let release: (value: unknown) => void = () => {};
    mocks.getTranslations.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Chapter marker' }));
    release({
      ...state('bilingual'),
      translations: [
        { entity_type: 'chapter', entity_id: 9, field: 'heading', language: 'en', text: 'Wedding ceremony' },
        { entity_type: 'chapter', entity_id: 9, field: 'location', language: 'en', text: 'Registry office' },
      ],
    });
    const tablist = await screen.findByRole('tablist');
    // The tab shows the arrived text, not an empty draft.
    fireEvent.click(within(tablist).getAllByRole('tab')[1]);
    expect((screen.getByLabelText('Heading') as HTMLInputElement).value).toBe('Wedding ceremony');
    fireEvent.click(within(tablist).getAllByRole('tab')[0]);
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '12:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() => expect(mocks.updateChapter).toHaveBeenCalled());
    expect(mocks.saveTranslations).not.toHaveBeenCalled();
  });

  it('removing the marker leaves its translations to the server, before or after they load', async () => {
    mocks.getTranslations.mockReturnValue(new Promise(() => {}));
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Chapter marker' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove marker' }));
    await waitFor(() => expect(mocks.updateChapter).toHaveBeenCalledWith(4, 9, {
      chapter_heading: null, chapter_subheading: null, chapter_time: null, chapter_location: null,
    }));
    expect(mocks.saveTranslations).not.toHaveBeenCalled();
  });

  it('bilingual: the chapter marker takes the second language next to the marker itself', async () => {
    mocks.getTranslations.mockResolvedValue(state('bilingual'));
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Chapter marker' }));
    const tablist = screen.getByRole('tablist');
    expect(within(tablist).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['de', 'en']);
    fireEvent.click(within(tablist).getAllByRole('tab')[1]);
    // The time has no translation; the default heading is the hint.
    expect(screen.queryByLabelText('Time')).toBeNull();
    const heading = screen.getByLabelText('Heading') as HTMLInputElement;
    expect(heading.placeholder).toBe('Die Trauung');
    fireEvent.change(heading, { target: { value: 'The ceremony' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() => expect(mocks.saveTranslations).toHaveBeenCalledWith(4, [
      { entity_type: 'chapter', entity_id: 9, field: 'heading', language: 'en', text: 'The ceremony' },
    ]));
    expect(mocks.updateChapter).toHaveBeenCalledWith(4, 9, expect.objectContaining({ chapter_heading: 'Die Trauung', chapter_time: '12:00' }));
  });
});
