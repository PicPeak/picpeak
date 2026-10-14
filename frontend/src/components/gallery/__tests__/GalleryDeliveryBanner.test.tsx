/**
 * Two-stage delivery banner (issue 1562): a partial gallery says how far the
 * delivery is and draws the placeholder tiles; a complete one renders nothing.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { GalleryDeliveryBanner } from '../GalleryDeliveryBanner';
import type { GalleryDelivery } from '../../../types';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (_key: string, fallback?: string, vars?: Record<string, unknown>) =>
        (fallback || _key).replace(/\{\{(\w+)\}\}/g, (_m, name) => String(vars?.[name] ?? '')),
      i18n: { language: 'en' },
    }),
  };
});

// The general date format setting is the hook's business; pin a recognisable
// output so the test proves the banner goes through it.
const formatSpy = vi.hoisted(() => vi.fn((_date: Date | string) => '12.07.2026'));
vi.mock('../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({ format: formatSpy }),
}));

vi.mock('../../../contexts/ThemeContext', async () => {
  const actual = await vi.importActual<typeof import('../../../contexts/ThemeContext')>(
    '../../../contexts/ThemeContext'
  );
  return { ...actual, useTheme: () => ({ theme: { galleryLayout: 'grid', gallerySettings: {} } }) };
});

const partial = (over: Partial<GalleryDelivery> = {}): GalleryDelivery => ({
  status: 'partial',
  expected_count: 240,
  delivered_count: 166,
  placeholder_count: 12,
  due_at: '2026-07-12T00:00:00.000Z',
  badge_label: null,
  ...over,
});

describe('GalleryDeliveryBanner', () => {
  it('states the progress and the promised date for a partial delivery', () => {
    render(<GalleryDeliveryBanner delivery={partial()} />);
    expect(screen.getByText('More photos are on their way')).toBeInTheDocument();
    expect(
      screen.getByText(/166 of approx\. 240 photos are here\..*by 12\.07\.2026 at the latest\./)
    ).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '166');
  });

  it('formats the promised day as its UTC date, the day the admin picked', () => {
    // Stored at noon UTC: 01:00 on the 13th in Auckland (summer) or Kiritimati.
    formatSpy.mockClear();
    render(<GalleryDeliveryBanner delivery={partial({ due_at: '2026-07-12T12:00:00.000Z' })} />);
    const day = formatSpy.mock.calls[0][0] as Date;
    expect(day).toBeInstanceOf(Date);
    expect([day.getFullYear(), day.getMonth(), day.getDate()]).toEqual([2026, 6, 12]);
  });

  it('draws placeholder_count hidden, non-interactive skeleton tiles', () => {
    render(<GalleryDeliveryBanner delivery={partial({ placeholder_count: 7 })} />);
    const placeholders = screen.getByTestId('gallery-delivery-placeholders');
    expect(placeholders).toHaveAttribute('aria-hidden', 'true');
    expect(placeholders.children).toHaveLength(7);
    expect(placeholders.querySelectorAll('button, a')).toHaveLength(0);
    expect(placeholders.firstElementChild).toHaveClass('skeleton');
  });

  it('draws no placeholders when the layout asks for the banner only', () => {
    render(<GalleryDeliveryBanner delivery={partial()} showPlaceholders={false} />);
    expect(screen.getByTestId('gallery-delivery-banner')).toBeInTheDocument();
    expect(screen.queryByTestId('gallery-delivery-placeholders')).not.toBeInTheDocument();
  });

  it('drops the count and the bar when no total was promised', () => {
    render(<GalleryDeliveryBanner delivery={partial({ expected_count: null })} />);
    expect(
      screen.getByText('Your photographer is still working on the remaining images — the complete gallery will be here by 12.07.2026 at the latest.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('drops the date when none was set', () => {
    render(<GalleryDeliveryBanner delivery={partial({ due_at: null })} />);
    expect(
      screen.getByText('166 of approx. 240 photos are here. Your photographer is still working on the remaining images.')
    ).toBeInTheDocument();
  });

  it('renders nothing for a complete gallery', () => {
    const { container } = render(<GalleryDeliveryBanner delivery={partial({ status: 'complete' })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for an ordinary gallery', () => {
    const { container } = render(<GalleryDeliveryBanner delivery={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
