/**
 * An Escape that cancels an IME composition (Japanese, Chinese, Korean input)
 * belongs to the field it is typed in. The admin dialogs used to close on
 * it, dropping what was typed. Chrome marks the keydown `isComposing`;
 * Safari ends the composition first and only sends keyCode 229.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect } from 'vitest';
import { Modal } from '../Modal';
import { useModalFocus } from '../../../hooks/useModalFocus';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}));

const COMPOSING = [{ isComposing: true }, { keyCode: 229 }];

describe('Modal', () => {
  it('stays open on a composing Escape and closes on a plain one', () => {
    const onClose = vi.fn();
    render(<Modal open onClose={onClose} title="Rename"><input aria-label="Name" /></Modal>);
    for (const flags of COMPOSING) fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Escape', ...flags });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});




describe('useModalFocus', () => {
  it('leaves a composing Escape to the field', () => {
    const onClose = vi.fn();
    const Panel = () => {
      const ref = useModalFocus<HTMLDivElement>(true, onClose);
      return <div ref={ref}><input aria-label="Note" /></div>;
    };
    render(<Panel />);
    for (const flags of COMPOSING) fireEvent.keyDown(screen.getByLabelText('Note'), { key: 'Escape', ...flags });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText('Note'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
