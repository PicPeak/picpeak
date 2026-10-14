/**
 * Naming a person inline: Enter saves, Escape cancels the rename and leaves
 * the window open. The Enter that commits an IME composition (Japanese,
 * Chinese, Korean input) and the Escape that cancels one belong to the field:
 * they must neither save, cancel the rename nor close the window.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-toastify', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: unknown) => (opts && typeof opts === 'object' && 'defaultValue' in (opts as object)
      ? String((opts as { defaultValue: string }).defaultValue) : key),
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
const post = vi.fn(async () => ({ data: {} }));
const patch = vi.fn(async () => ({ data: {} }));
vi.mock('../../../config/api', () => ({
  api: {
    get: vi.fn(async (url: string) => {
      if (url.endsWith('/people')) {
        return { data: { people: [{ id: 7, label: 'Anna', face_count: 3, cover: null }] } };
      }
      if (url.endsWith('/suggestions')) return { data: { suggestions: [] } };
      return { data: { faces: [] } };
    }),
    post: (...args: unknown[]) => post(...args),
    patch: (...args: unknown[]) => patch(...args),
    put: vi.fn(async () => ({ data: {} })),
    delete: vi.fn(async () => ({ data: {} })),
  },
}));

import { PeopleManagerModal } from '../PeopleManagerModal';

describe('PeopleManagerModal inline rename', () => {
  it('leaves Escape and Enter of an IME composition to the name field', async () => {
    const onClose = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <PeopleManagerModal eventId={1} open onClose={onClose} />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Anna' }));
    const field = screen.getByDisplayValue('Anna');
    fireEvent.change(field, { target: { value: 'Anna Muster' } });
    for (const flags of [{ isComposing: true }, { keyCode: 229 }]) {
      fireEvent.keyDown(field, { key: 'Enter', ...flags });
      fireEvent.keyDown(field, { key: 'Escape', ...flags });
    }
    expect(screen.getByDisplayValue('Anna Muster')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();

    // A plain Escape cancels the rename only.
    fireEvent.keyDown(field, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByDisplayValue('Anna Muster')).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
  });
});
