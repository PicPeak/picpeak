/**
 * Shared portal list pieces: the four sorts (string minors from PostgreSQL
 * included) and the load-error block with and without its page title.
 */
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect } from 'vitest';
import { sortPortalRows, PortalLoadError } from '../PortalListControls';

vi.mock('react-i18next', async () => ({
  ...(await vi.importActual<typeof import('react-i18next')>('react-i18next')),
  useTranslation: () => ({ t: (key: string, fallback?: string) => (typeof fallback === 'string' ? fallback : key) }),
}));

const rows = [
  { id: 1, issueDate: '2026-03-01', totalAmountMinor: '5000' as unknown as number },
  { id: 2, issueDate: '2026-01-15', totalAmountMinor: 20000 },
  { id: 3, issueDate: '2026-06-30' },
];

describe('sortPortalRows', () => {
  it.each([
    ['newest', [3, 1, 2]],
    ['oldest', [2, 1, 3]],
    ['price_desc', [2, 1, 3]],
    ['price_asc', [3, 1, 2]],
  ] as const)('%s', (sort, ids) => {
    expect(sortPortalRows(rows, sort).map((r) => r.id)).toEqual(ids);
  });

  it('leaves the input order alone', () => {
    sortPortalRows(rows, 'oldest');
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3]);
  });
});

describe('PortalLoadError', () => {
  const props = {
    title: 'Bills', disabledText: 'Not enabled for your account', loadErrorTitle: 'Could not load',
    onRetry: () => {}, retrying: false,
  };

  it('shows the title and the disabled text on a 403', () => {
    render(<PortalLoadError {...props} error={{ response: { status: 403 } }} />);
    expect(screen.getByRole('heading', { name: 'Bills' })).toBeInTheDocument();
    expect(screen.getByText('Not enabled for your account')).toBeInTheDocument();
  });

  it('shows only the retry block on another error', () => {
    render(<PortalLoadError {...props} error={new Error('boom')} />);
    expect(screen.queryByRole('heading', { name: 'Bills' })).toBeNull();
    expect(screen.getByText('Could not load')).toBeInTheDocument();
  });

  it('keeps the title above the retry block with alwaysShowTitle', () => {
    render(<PortalLoadError {...props} alwaysShowTitle error={new Error('boom')} />);
    expect(screen.getByRole('heading', { name: 'Bills' })).toBeInTheDocument();
    expect(screen.getByText('Could not load')).toBeInTheDocument();
  });
});
