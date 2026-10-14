/**
 * Renaming a category inline: Enter saves, Escape cancels. The handler sat
 * on keypress, which browsers never fire for Escape, so Escape did nothing.
 * On keydown, the Enter that commits an IME composition (Japanese, Chinese,
 * Korean input) and the Escape that cancels one stay with the field.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-toastify', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key), i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
const updateCategory = vi.fn(async () => ({}));
const createCategory = vi.fn(async () => ({}));
vi.mock('../../../services/categories.service', () => ({
  categoriesService: {
    getGlobalCategories: vi.fn(async () => [{ id: 1, name: 'Ceremony', slug: 'ceremony', is_global: true }]),
    updateCategory: (...args: unknown[]) => updateCategory(...args),
    reorderGlobalCategories: vi.fn(),
    createCategory: (...args: unknown[]) => createCategory(...args),
    deleteCategory: vi.fn(),
  },
}));

import { CategoryManager } from '../CategoryManager';

async function openRename() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CategoryManager />
    </QueryClientProvider>,
  );
  await screen.findByText('Ceremony');
  fireEvent.click(screen.getByTitle(/edit/i));
  return screen.getByDisplayValue('Ceremony');
}

describe('CategoryManager inline rename', () => {
  it('cancels on Escape', async () => {
    const field = await openRename();
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.queryByDisplayValue('Ceremony')).toBeNull();
  });

  it('leaves Escape and Enter of an IME composition to the field', async () => {
    const field = await openRename();
    fireEvent.change(field, { target: { value: 'Zeremonie' } });
    for (const flags of [{ isComposing: true }, { keyCode: 229 }]) {
      fireEvent.keyDown(field, { key: 'Enter', ...flags });
      fireEvent.keyDown(field, { key: 'Escape', ...flags });
    }
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(screen.getByDisplayValue('Zeremonie')).toBeInTheDocument();
    expect(updateCategory).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(updateCategory).toHaveBeenCalled());
  });

  it('does not add a category on the Enter that commits an IME composition', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CategoryManager />
      </QueryClientProvider>,
    );
    await screen.findByText('Ceremony');
    fireEvent.click(screen.getByRole('button', { name: /add/i }));
    const field = screen.getByPlaceholderText('categories.categoryName');
    fireEvent.change(field, { target: { value: 'Empfang' } });
    fireEvent.keyPress(field, { key: 'Enter', code: 'Enter', charCode: 13, isComposing: true });
    // The mutation starts on a later tick.
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(createCategory).not.toHaveBeenCalled();
    fireEvent.keyPress(field, { key: 'Enter', code: 'Enter', charCode: 13 });
    await waitFor(() => expect(createCategory).toHaveBeenCalled());
  });
});
