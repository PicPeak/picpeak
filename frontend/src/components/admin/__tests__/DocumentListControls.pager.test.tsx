/**
 * The shared admin list pager: hidden for a single page, steps from the
 * latest page (the state setter's functional form, as Contracts had it) and
 * never leaves 1..totalPages.
 */
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect } from 'vitest';
import { Pager } from '../DocumentListControls';

vi.mock('react-i18next', async () => ({
  ...(await vi.importActual<typeof import('react-i18next')>('react-i18next')),
  useTranslation: () => ({ t: (key: string, fallback?: string) => (typeof fallback === 'string' ? fallback : key) }),
}));

function Harness({ totalPages, start = 1 }: { totalPages: number; start?: number }) {
  const [page, setPage] = useState(start);
  return <Pager page={page} totalPages={totalPages} onPageChange={setPage} label={`page ${page}`} />;
}

describe('Pager', () => {
  it('renders nothing for a single page', () => {
    const { container } = render(<Harness totalPages={1} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('steps forward and back and disables the ends', () => {
    render(<Harness totalPages={3} />);
    const prev = screen.getByRole('button', { name: 'Previous' });
    const next = screen.getByRole('button', { name: 'Next' });
    expect(prev).toBeDisabled();

    fireEvent.click(next);
    fireEvent.click(next);
    expect(screen.getByText('page 3')).toBeInTheDocument();
    expect(next).toBeDisabled();

    fireEvent.click(prev);
    expect(screen.getByText('page 2')).toBeInTheDocument();
  });

  it('applies two clicks before a re-render as two steps, clamped to the last page', () => {
    const setPage = vi.fn();
    render(<Pager page={1} totalPages={2} onPageChange={setPage} label="x" />);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    const step = setPage.mock.calls[0][0] as (p: number) => number;
    expect(step(1)).toBe(2);
    expect(step(2)).toBe(2);
  });
});
