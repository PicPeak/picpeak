/**
 * The view switch renders inside the grid below the hero (issue 2504), and
 * the grid is keyed by the view, so pressing "All photos" remounts the
 * switch. A keyboard press keeps the focus on the switch: the new instance
 * focuses the view it was switched to.
 */
import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { GalleryViewSwitch } from '../GalleryViewSwitch';
import type { GalleryViewMode } from '../folders';

vi.mock('react-i18next', async () => ({
  ...(await vi.importActual<typeof import('react-i18next')>('react-i18next')),
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key, i18n: { language: 'en' } }),
}));

function Keyed() {
  const [view, setView] = useState<GalleryViewMode>('folders');
  // Remounts on every change, like the grid keyed by gridKey.
  return <div key={view}><GalleryViewSwitch view={view} onChange={setView} /></div>;
}

describe('GalleryViewSwitch focus across a remount', () => {
  it('focuses the pressed view in the new switch', () => {
    render(<Keyed />);
    const all = screen.getByRole('button', { name: 'All photos' });
    all.focus();
    fireEvent.click(all);
    const allAfter = screen.getByRole('button', { name: 'All photos' });
    expect(allAfter).not.toBe(all);
    expect(allAfter).toHaveAttribute('aria-pressed', 'true');
    expect(document.activeElement).toBe(allAfter);
  });

  it('does not take the focus when the press did not have it', () => {
    render(<Keyed />);
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    outside.focus();
    fireEvent.click(screen.getByRole('button', { name: 'All photos' }));
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});
