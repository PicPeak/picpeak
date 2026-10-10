import React, { useRef, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useGalleryDialog } from '../useGalleryDialog';
import { lockBodyScroll } from '../../../../utils/scrollLock';

const Dialog: React.FC<{ onClose: () => void; dismissible?: boolean }> = ({ onClose, dismissible }) => {
  const panelRef = useRef<HTMLDivElement>(null);
  useGalleryDialog({ open: true, onClose, panelRef, dismissible });
  return (
    <div ref={panelRef} role="dialog" aria-label="Themed">
      <button type="button">First</button>
      <button type="button">Last</button>
    </div>
  );
};

const Harness: React.FC<{ dismissible?: boolean }> = ({ dismissible }) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open</button>
      {open && <Dialog onClose={() => setOpen(false)} dismissible={dismissible} />}
    </>
  );
};

describe('useGalleryDialog', () => {
  it('focuses inside, keeps Tab inside, closes on Escape and gives focus back', () => {
    render(<Harness />);
    const opener = screen.getByText('Open');
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(screen.getByText('First'));

    screen.getByText('Last').focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByText('First'));

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('keeps Escape from reaching the lightbox underneath', () => {
    const lightboxKeys = vi.fn();
    document.addEventListener('keydown', lightboxKeys);
    render(<Harness />);
    fireEvent.click(screen.getByText('Open'));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(lightboxKeys).not.toHaveBeenCalled();
    document.removeEventListener('keydown', lightboxKeys);
  });

  it('ignores Escape when the dialog must be answered', () => {
    render(<Harness dismissible={false} />);
    fireEvent.click(screen.getByText('Open'));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('leaves the page scrollable when the lightbox under a dialog closes first', () => {
    // The lightbox takes the shared lock; the identity prompt opens over it.
    document.body.style.overflow = 'auto';
    const releaseLightbox = lockBodyScroll();
    const view = render(<Dialog onClose={() => {}} />);
    expect(document.body.style.overflow).toBe('hidden');
    // Back closes the lightbox first, then the dialog goes away.
    releaseLightbox();
    expect(document.body.style.overflow).toBe('hidden');
    view.unmount();
    expect(document.body.style.overflow).toBe('auto');
  });

  it('leaves the page scrollable when the dialog closes before the lightbox', () => {
    document.body.style.overflow = 'auto';
    const releaseLightbox = lockBodyScroll();
    const view = render(<Dialog onClose={() => {}} />);
    view.unmount();
    expect(document.body.style.overflow).toBe('hidden');
    releaseLightbox();
    expect(document.body.style.overflow).toBe('auto');
  });
});
