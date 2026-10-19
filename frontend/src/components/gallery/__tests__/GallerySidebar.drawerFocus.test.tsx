/**
 * On a phone the open sidebar is a drawer over a backdrop. Opening it by
 * keyboard used to leave focus on the header toggle, and Tab walked the
 * header and gallery controls behind the backdrop. The drawer now takes focus
 * and keeps Tab inside; the desktop panel leaves focus alone.
 */
import React, { useRef, useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

const Harness: React.FC<{ isMobile: boolean; startOpen?: boolean; dialog?: boolean }> = ({ isMobile, startOpen = false, dialog = false }) => {
  const [open, setOpen] = useState(startOpen);
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
        onSortDescChange={() => {}}
        isSelectionMode={false}
        onToggleSelectionMode={() => {}}
        selectedCount={0}
        onDownloadAll={() => {}}
        onDownloadSelected={() => {}}
        isDownloading={false}
        totalPhotos={0}
        isMobile={isMobile}
      />
      <button>behind</button>
      {dialog && <div role="dialog"><button>dialog action</button></div>}
    </>
  );
};

describe('GallerySidebar drawer focus on a phone', () => {
  it('moves focus to the close button when opened by keyboard', async () => {
    const user = userEvent.setup();
    render(<Harness isMobile />);
    screen.getByText('toggle').focus();
    await user.keyboard('{Enter}');

    expect(screen.getByRole('button', { name: 'common.close' })).toHaveFocus();
  });

  it('wraps Tab inside the drawer instead of reaching the page behind', async () => {
    const user = userEvent.setup();
    render(<Harness isMobile />);
    screen.getByText('toggle').focus();
    await user.keyboard('{Enter}');

    const close = screen.getByRole('button', { name: 'common.close' });
    // The tile-size switch (issue 1733, E4) is the drawer's last section.
    const last = screen.getByRole('button', { name: 'gallery.density.large' });
    last.focus();
    await user.tab();
    expect(close).toHaveFocus();

    await user.tab({ shift: true });
    expect(last).toHaveFocus();
  });

  it('pulls focus back in when it reaches the page from nowhere', async () => {
    const user = userEvent.setup();
    render(<Harness isMobile />);
    screen.getByText('toggle').focus();
    await user.keyboard('{Enter}');

    // The focused control unmounted: focus sits on the body, and the next
    // Shift+Tab lands on the page behind the drawer.
    (document.activeElement as HTMLElement).blur();
    screen.getByText('behind').focus();
    expect(screen.getByRole('button', { name: 'common.close' })).toHaveFocus();
  });

  it('leaves a dialog on top its focus when a resize turns the panel into the drawer', () => {
    const { rerender } = render(<Harness isMobile={false} startOpen dialog />);
    const action = screen.getByText('dialog action');
    action.focus();
    rerender(<Harness isMobile startOpen dialog />);

    expect(action).toHaveFocus();
  });

  it('returns focus to the toggle on Escape', async () => {
    const user = userEvent.setup();
    render(<Harness isMobile />);
    screen.getByText('toggle').focus();
    await user.keyboard('{Enter}');
    await user.keyboard('{Escape}');

    expect(screen.getByText('toggle')).toHaveFocus();
  });

  it('leaves focus on the toggle for the desktop panel', async () => {
    const user = userEvent.setup();
    render(<Harness isMobile={false} />);
    screen.getByText('toggle').focus();
    await user.keyboard('{Enter}');

    expect(screen.getByText('toggle')).toHaveFocus();
  });
});
