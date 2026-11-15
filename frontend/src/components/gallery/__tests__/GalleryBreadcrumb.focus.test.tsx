/**
 * The breadcrumb renders inside the grid below the hero (issue 2504), and the
 * grid is keyed by the open folder, so the Back button remounts on every step
 * up. A keyboard press keeps the focus on Back, so repeated presses keep
 * walking up the folder tree.
 */
import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { GalleryBreadcrumb } from '../GalleryBreadcrumb';
import { folderKey } from '../folders';
import type { PhotoCategory } from '../../../types';

vi.mock('react-i18next', async () => ({
  ...(await vi.importActual<typeof import('react-i18next')>('react-i18next')),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

const folder = (id: number, name: string, parent: number | null) =>
  ({ id, name, slug: name.toLowerCase(), is_folder: true, parent_id: parent }) as unknown as PhotoCategory;
const tree = [folder(1, 'Saturday', null), folder(2, 'Party', 1), folder(3, 'Late', 2)];

function Keyed() {
  const [depth, setDepth] = useState(3);
  const trail = tree.slice(0, depth);
  // Remounts on every step, like the grid keyed by gridKey.
  return (
    <div key={depth}>
      <GalleryBreadcrumb
        trail={trail}
        onNavigate={(key) => setDepth(key ? tree.findIndex((f) => folderKey(f) === key) + 1 : 0)}
      />
    </div>
  );
}

describe('GalleryBreadcrumb Back focus across a remount', () => {
  it('keeps the focus on Back while stepping up', () => {
    render(<Keyed />);
    const back = screen.getByRole('button', { name: 'gallery.folderUp' });
    back.focus();
    fireEvent.click(back);
    const backAfter = screen.getByRole('button', { name: 'gallery.folderUp' });
    expect(backAfter).not.toBe(back);
    expect(document.activeElement).toBe(backAfter);
  });

  it('leaves the focus alone when Back was pressed without it', () => {
    render(<Keyed />);
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    outside.focus();
    fireEvent.click(screen.getByRole('button', { name: 'gallery.folderUp' }));
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});
