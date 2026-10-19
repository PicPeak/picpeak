/**
 * The phone's bottom sheet (issue 1733, E5): focus moves in and goes back to
 * the opener, Escape, the backdrop and a pull on the handle close it, and the
 * page behind it does not scroll while it is open.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { GalleryBottomSheet } from '../GalleryBottomSheet';

// jsdom has no PointerEvent; without one the pointer events carry no clientY.
if (typeof window.PointerEvent === 'undefined') {
  class PointerEventStub extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  (window as unknown as { PointerEvent: typeof PointerEventStub }).PointerEvent = PointerEventStub;
}

const Harness: React.FC<{ onClose?: () => void }> = ({ onClose }) => {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>open</button>
      <GalleryBottomSheet open={open} onClose={() => { onClose?.(); setOpen(false); }} title="Filters">
        <button type="button">inside</button>
      </GalleryBottomSheet>
    </>
  );
};

const openSheet = () => {
  const opener = screen.getByRole('button', { name: 'open' });
  opener.focus();
  fireEvent.click(opener);
  return opener;
};

describe('GalleryBottomSheet', () => {
  it('keeps Tab inside when the focused control has been disabled', () => {
    const Busy: React.FC = () => {
      const [busy, setBusy] = React.useState(false);
      return (
        <>
          <GalleryBottomSheet open onClose={() => {}} title="Rate">
            <button type="button" disabled={busy} onClick={() => setBusy(true)}>star</button>
            <button type="button" disabled={busy}>clear</button>
          </GalleryBottomSheet>
          <button type="button">behind</button>
        </>
      );
    };
    render(<Busy />);
    const star = screen.getByRole('button', { name: 'star' });
    star.focus();
    fireEvent.click(star);
    expect(star).toBeDisabled();
    expect(star).toHaveFocus();
    const dialog = screen.getByRole('dialog', { name: 'Rate' });
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.activeElement!.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('is a modal dialog that takes focus and locks the page scroll', () => {
    render(<Harness />);
    openSheet();
    const dialog = screen.getByRole('dialog', { name: 'Filters' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('closes on Escape and hands focus back to the opener', () => {
    render(<Harness />);
    const opener = openSheet();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
    expect(document.body.style.overflow).toBe('');
  });

  it('closes on the backdrop', () => {
    render(<Harness />);
    openSheet();
    fireEvent.click(screen.getByTestId('sheet-backdrop'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes when pulled down far enough, and springs back from a short pull', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    openSheet();
    const handle = screen.getByTestId('sheet-handle');
    fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 130, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 130, pointerId: 1 });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 260, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 260, pointerId: 1 });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
