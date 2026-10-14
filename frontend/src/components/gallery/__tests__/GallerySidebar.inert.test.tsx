/**
 * The closed sidebar is only translated off screen; without `inert` its
 * controls stayed in the tab order and the accessibility tree (issue 1977).
 * The harness owns the open state and the toggle the way GalleryView does.
 */
import React, { useRef, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { GallerySidebar } from '../GallerySidebar';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
      i18n: { language: 'en' }
    })
  };
});

const Harness: React.FC<{ isMobile?: boolean }> = ({ isMobile = false }) => {
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={toggleRef} onClick={() => setOpen(!open)}>toggle</button>
      <GallerySidebar
        isOpen={open}
        onClose={() => setOpen(false)}
        returnFocusRef={toggleRef}
        categories={[]}
        selectedCategoryId={null}
        onCategoryChange={() => {}}
        searchTerm=""
        onSearchChange={() => {}}
        sortBy="date"
        onSortChange={() => {}}
        isSelectionMode={false}
        onToggleSelectionMode={() => {}}
        selectedCount={0}
        onDownloadAll={() => {}}
        onDownloadSelected={() => {}}
        isDownloading={false}
        totalPhotos={0}
        isMobile={isMobile}
      />
    </>
  );
};

const panel = (container: HTMLElement) => container.querySelector('.gallery-sidebar') as HTMLElement;

describe('GallerySidebar inert while closed (issue 1977)', () => {
  it('is inert while closed and reachable while open', () => {
    const { container } = render(<Harness />);
    expect(panel(container)).toHaveAttribute('inert');

    fireEvent.click(screen.getByText('toggle'));
    expect(panel(container)).not.toHaveAttribute('inert');

    fireEvent.click(screen.getByText('toggle'));
    expect(panel(container)).toHaveAttribute('inert');
  });

  it('hands focus back to the toggle when closed from inside', () => {
    const { container } = render(<Harness />);
    fireEvent.click(screen.getByText('toggle'));

    const close = screen.getByRole('button', { name: 'common.close' });
    close.focus();
    fireEvent.click(close);

    expect(panel(container)).toHaveAttribute('inert');
    expect(document.activeElement).toBe(screen.getByText('toggle'));
  });

  it('hands focus back when the mobile drawer closes on Escape', () => {
    const { container } = render(<Harness isMobile />);
    fireEvent.click(screen.getByText('toggle'));

    screen.getByRole('button', { name: 'common.close' }).focus();
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(panel(container)).toHaveAttribute('inert');
    expect(document.activeElement).toBe(screen.getByText('toggle'));
  });

  it('leaves focus alone when it is outside the sidebar', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('toggle'));
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    outside.focus();

    fireEvent.click(screen.getByText('toggle'));
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});
