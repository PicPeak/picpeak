import React, { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi } from 'vitest';
import { FolderTreePicker } from '../../components/admin/folders/FolderTreePicker';
import { radioGroupKeyDown } from '../ariaKeyboard';

const folders = [
  { id: 1, name: 'Ceremony', parent_id: null },
  { id: 2, name: 'Vows', parent_id: 1 },
  { id: 3, name: 'Party', parent_id: null },
];

const row = (name: string) => screen.getByRole('treeitem', { name });

describe('treeKeyDown (FolderTreePicker)', () => {
  it('moves with Up / Down, opens with Right, enters the child, goes back with Left', () => {
    render(<FolderTreePicker folders={folders} value={undefined} onChange={vi.fn()} allowRoot />);
    row('Gallery root').focus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(row('Ceremony'));

    // Closed: Right opens it, focus stays.
    expect(screen.queryByRole('treeitem', { name: 'Vows' })).toBeNull();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(row('Vows')).toBeInTheDocument();
    expect(row('Ceremony')).toHaveAttribute('aria-expanded', 'true');
    expect(row('Vows')).toHaveAttribute('aria-level', '3');
    expect(document.activeElement).toBe(row('Ceremony'));
    // Open: Right moves into the first child.
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(row('Vows'));
    // Left on a leaf goes to the parent, Left again closes it.
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(row('Ceremony'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(screen.queryByRole('treeitem', { name: 'Vows' })).toBeNull();
    // A top-level folder sits under "Gallery root".
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(row('Gallery root'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });

    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(document.activeElement).toBe(row('Party'));
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(document.activeElement).toBe(row('Gallery root'));
  });

  it('keeps the expand chevrons out of the Tab order', () => {
    render(<FolderTreePicker folders={folders} value={undefined} onChange={vi.fn()} />);
    const chevron = screen.getByLabelText('Expand');
    expect(chevron).toHaveAttribute('tabindex', '-1');
    expect(chevron).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('radioGroupKeyDown', () => {
  const Group = ({ onPick }: { onPick: (v: string) => void }) => {
    const [value, setValue] = useState('a');
    return (
      <div role="radiogroup" aria-label="Mode" onKeyDown={radioGroupKeyDown}>
        {['a', 'b', 'c'].map((v) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={value === v}
            tabIndex={value === v ? 0 : -1}
            onClick={() => { setValue(v); onPick(v); }}
          >
            {v}
          </button>
        ))}
      </div>
    );
  };

  it('moves to and picks the next option, wrapping at the ends', () => {
    const onPick = vi.fn();
    render(<Group onPick={onPick} />);
    screen.getByRole('radio', { name: 'a' }).focus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(onPick).toHaveBeenLastCalledWith('b');
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'b' }));
    expect(screen.getByRole('radio', { name: 'b' })).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(onPick).toHaveBeenLastCalledWith('c');
  });
});
