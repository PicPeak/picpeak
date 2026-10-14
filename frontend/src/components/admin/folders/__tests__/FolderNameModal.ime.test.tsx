/**
 * Enter in the folder name confirms the dialog, but not the Enter that
 * commits an IME composition (Japanese, Chinese, Korean input): that one
 * finishes the word being typed.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, fb?: string) => fb ?? _k }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

import { FolderNameModal } from '../FolderNameModal';

describe('FolderNameModal', () => {
  it('confirms on Enter, not on the Enter that commits a composition', () => {
    const onConfirm = vi.fn();
    render(<FolderNameModal isOpen title="New folder" confirmLabel="Create" onClose={vi.fn()} onConfirm={onConfirm} />);
    const field = screen.getByLabelText('Folder name');
    fireEvent.change(field, { target: { value: 'Trauung' } });
    fireEvent.keyDown(field, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(field, { key: 'Enter', keyCode: 229 });
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onConfirm).toHaveBeenCalledWith('Trauung');
  });
});
