import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { CreditFilterChips } from '../CreditFilterChips';
import type { Photo } from '../../../types';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  };
});

const photo = (id: number, fields: Partial<Photo>): Photo => ({
  id, filename: `${id}.jpg`, url: '', type: 'individual', size: 1, uploaded_at: '2026-09-01T00:00:00Z', ...fields,
});

describe('CreditFilterChips (#1561)', () => {
  it('lists every name with its count and selects one', async () => {
    const onChange = vi.fn();
    render(
      <CreditFilterChips
        photos={[
          photo(1, { credit_name: 'Anna', uploaded_by_guest: true }),
          photo(2, { credit_name: 'Anna', uploaded_by_guest: true }),
          photo(3, { credit_name: null }),
        ]}
        selectedKey={null}
        onChange={onChange}
      />
    );
    expect(screen.getByRole('button', { name: 'gallery.credits.everyone (3)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'gallery.credits.photographer (1)' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Anna (2)' }));
    expect(onChange).toHaveBeenCalledWith('name:Anna');
  });

  it('renders nothing when no photo carries a name', () => {
    const { container } = render(
      <CreditFilterChips photos={[photo(1, {}), photo(2, { uploaded_by_guest: true })]} selectedKey={null} onChange={vi.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
