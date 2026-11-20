import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { GalleryCategoryChips } from '../GalleryCategoryChips';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  };
});

const categories = ['Sneak Peek', 'Bride & Groom', 'Group Portraits', 'Pre-Ceremony', 'Reception'].map(
  (name, i) => ({ id: i + 1, name, slug: name.toLowerCase() })
);
const photos = categories.map((c) => ({ category_id: c.id }));

describe('GalleryCategoryChips', () => {
  it('wraps the chips onto more lines instead of a horizontal scroll row', () => {
    render(
      <GalleryCategoryChips categories={categories} photos={photos} selectedCategoryId={null} onCategoryChange={vi.fn()} />
    );
    const row = screen.getByRole('button', { name: 'Reception (1)' }).parentElement!;
    expect(row).toHaveClass('flex-wrap');
    expect(row).not.toHaveClass('min-w-max');
    expect(row.parentElement).not.toHaveClass('overflow-x-auto');
  });

  it('lets a long category name wrap inside its own chip', () => {
    const name = 'Getting ready – bride and bridesmaids at the hotel';
    render(
      <GalleryCategoryChips
        categories={[{ id: 1, name, slug: 'getting-ready' }]}
        photos={[{ category_id: 1 }]}
        selectedCategoryId={null}
        onCategoryChange={vi.fn()}
      />
    );
    const chip = screen.getByRole('button', { name: `${name} (1)` });
    expect(chip).toHaveClass('max-w-full', 'h-auto', 'whitespace-normal', 'break-words');
    expect(chip).not.toHaveClass('whitespace-nowrap');
  });
});
