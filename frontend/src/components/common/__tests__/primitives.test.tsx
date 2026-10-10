import React, { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmDialogProvider, useConfirm } from '../ConfirmDialog';
import { vi, describe, it, expect } from 'vitest';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { Input } from '../Input';
import { Notice } from '../Notice';
import { Modal } from '../Modal';
import { ActionMenu } from '../ActionMenu';
import { useEscapeClose } from '../useEscapeClose';
import { Tabs } from '../Tabs';
import { Switch } from '../Switch';
import { ErrorState } from '../EmptyState';
import { DecimalInput } from '../DecimalInput';
import { Input } from '../Input';
import { Table, TableBody, TableRow, TableCell } from '../Table';
import { applyStatusColors, normalizeStatusColors } from '../../../utils/statusColors';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}));

describe('Badge', () => {
  it('reads the status tokens for its tone, never a raw palette', () => {
    render(<Badge tone="danger">Overdue</Badge>);
    const badge = screen.getByText('Overdue');
    expect(badge.className).toContain('bg-danger-soft');
    expect(badge.className).toContain('text-danger-text');
    expect(badge.className).not.toMatch(/red-\d/);
  });

  it('has an outline look for states that are not there yet', () => {
    render(<Badge tone="neutral" appearance="outline">Roadmap</Badge>);
    expect(screen.getByText('Roadmap').className).toContain('border-line-strong');
  });
});

describe('Button', () => {
  it('ghost does not hard-code an admin text colour, so it follows a dark gallery theme', () => {
    render(<Button variant="ghost">Cancel</Button>);
    const button = screen.getByRole('button', { name: 'Cancel' });
    expect(button.className).toContain('btn-ghost');
    // text-body / hover:bg-hover are admin UI tokens: on a gallery (no .dark
    // class) they stay light-mode grey on whatever surface the theme paints.
    expect(button.className).not.toMatch(/\btext-body\b|\bhover:bg-hover\b/);
  });
});

describe('Input', () => {
  it('themed reads the gallery theme for the field, not only for the label', () => {
    render(<Input themed label="Your name" error="Name is required" />);
    const field = screen.getByLabelText('Your name');
    expect(field.className).toContain('input-themed');
    expect(field.className).not.toMatch(/(^|\s)input(\s|$)/);
    expect(screen.getByText('Name is required').className).toContain('hue-danger');
  });

  it('themed: the label and icons read the theme tokens too', () => {
    render(<Input themed label="Email" leftIcon={<span data-testid="icon" />} />);
    expect(screen.getByText('Email').className).toContain('text-theme');
    expect(screen.getByTestId('icon').parentElement?.className).toBe('text-muted-theme');
  });

  it('keeps the admin field without themed', () => {
    render(<Input label="Email" />);
    expect(screen.getByLabelText('Email').className).toMatch(/(^|\s)input(\s|$)/);
  });
});

describe('Notice', () => {
  it('is an alert when it reports a failure and a status otherwise', () => {
    const { rerender } = render(<Notice tone="danger">Import failed</Notice>);
    expect(screen.getByRole('alert')).toHaveTextContent('Import failed');
    rerender(<Notice tone="info">Read-only</Notice>);
    expect(screen.getByRole('status')).toHaveTextContent('Read-only');
  });
});

describe('Modal', () => {
  const Harness = () => {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Open</button>
        <Modal open={open} onClose={() => setOpen(false)} title="Rename gallery">
          <input aria-label="Name" />
        </Modal>
      </>
    );
  };

  it('labels itself, focuses inside, closes on Escape and gives focus back', () => {
    render(<Harness />);
    const opener = screen.getByText('Open');
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Rename gallery' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe('Tabs', () => {
  it('moves with the arrow keys and marks the selected tab', () => {
    const onChange = vi.fn();
    render(
      <Tabs
        items={[{ id: 'overview', label: 'Overview' }, { id: 'settings', label: 'Settings', dirty: true, dirtyLabel: 'Unsaved' }]}
        value="overview"
        onChange={onChange}
      />,
    );
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Overview' }), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('settings');
    expect(screen.getByRole('img', { name: 'Unsaved' })).toBeInTheDocument();
  });
});

describe('Switch', () => {
  it('flips through its visible label', () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onChange={onChange} label="Watch this folder" />);
    const control = screen.getByRole('switch', { name: 'Watch this folder' });
    expect(control).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(control);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe('ErrorState', () => {
  it('offers Retry', () => {
    const onRetry = vi.fn();
    render(<ErrorState onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalled();
  });
});

describe('status colours', () => {
  it('writes the picked hues on <html> and clears the rest', () => {
    const root = document.documentElement;
    applyStatusColors({ danger: '#ff0000' });
    expect(root.style.getPropertyValue('--status-danger')).toBe('#ff0000');
    applyStatusColors(normalizeStatusColors({ danger: 'not-a-colour' }));
    expect(root.style.getPropertyValue('--status-danger')).toBe('');
  });
});

describe('DecimalInput', () => {
  it('reformats on blur and still calls the caller\'s onBlur', () => {
    const onBlur = vi.fn();
    const onChange = vi.fn();
    render(<DecimalInput aria-label="Rate" value={8} onChange={onChange} onBlur={onBlur} fractionDigits={2} />);
    const input = screen.getByLabelText('Rate') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '8,1' } });
    expect(onChange).toHaveBeenLastCalledWith(8.1);
    fireEvent.blur(input);
    expect(input.value).toBe('8.10');
    expect(onBlur).toHaveBeenCalledTimes(1);
  });
});

describe('TableCell', () => {
  it('lets a caller colour replace the default body colour', () => {
    render(<Table><TableBody><TableRow><TableCell className="text-heading">Total</TableCell></TableRow></TableBody></Table>);
    const cell = screen.getByText('Total');
    expect(cell.className).toContain('text-heading');
    expect(cell.className).not.toContain('text-body');
  });
});

describe('Modal under a confirm', () => {
  it('Escape closes only the confirm on top, not the dialog beneath it', async () => {
    const onClose = vi.fn();
    let answer: boolean | undefined;
    const Harness = () => {
      const confirm = useConfirm();
      return (
        <Modal open onClose={onClose} title="Transfer">
          <button onClick={async () => { answer = await confirm({ message: 'Delete it?' }); }}>Delete</button>
        </Modal>
      );
    };
    render(<ConfirmDialogProvider><Harness /></ConfirmDialogProvider>);
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await screen.findByText('Delete it?');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(answer).toBe(false));
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('useEscapeClose', () => {
  const Overlay = ({ onClose, enabled = true }: { onClose: () => void; enabled?: boolean }) => {
    useEscapeClose(true, onClose, { enabled });
    return <div>drawer</div>;
  };

  it('closes the overlay on Escape, and waits while a request runs', () => {
    const onClose = vi.fn();
    const { rerender } = render(<Overlay onClose={onClose} enabled={false} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    rerender(<Overlay onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('leaves the overlay open when a Modal on top takes the Escape', () => {
    const onDrawer = vi.fn();
    const onModal = vi.fn();
    render(
      <>
        <Overlay onClose={onDrawer} />
        <Modal open onClose={onModal} title="On top">x</Modal>
      </>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onModal).toHaveBeenCalledTimes(1);
    expect(onDrawer).not.toHaveBeenCalled();
  });
});

describe('ActionMenu', () => {
  it('opens to the right when a right-anchored dropdown would leave the viewport, and skips disabled items', () => {
    const onA = vi.fn();
    render(<ActionMenu items={[{ key: 'a', label: 'Convert', disabled: true, onSelect: onA }, { key: 'b', label: 'Duplicate', onSelect: vi.fn() }]} />);
    const button = screen.getByRole('button', { name: 'More actions' });
    // A menu button at the far left of a 390 px phone.
    button.parentElement!.getBoundingClientRect = () => ({ left: 16, right: 56, top: 0, bottom: 40, width: 40, height: 40, x: 16, y: 0, toJSON: () => ({}) });
    fireEvent.click(button);
    const menu = screen.getByRole('menu');
    expect(menu).toHaveClass('left-0');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Convert' }));
    expect(onA).not.toHaveBeenCalled();
  });
});

describe('ConfirmDialog and Enter', () => {
  const Ask = ({ variant, onAnswer }: { variant?: 'danger'; onAnswer: (v: boolean) => void }) => {
    const confirm = useConfirm();
    return <button onClick={async () => onAnswer(await confirm({ message: 'Sure?', variant }))}>Ask</button>;
  };

  it('Enter on the focused Cancel cancels; a danger confirm never confirms from elsewhere', async () => {
    const answers: boolean[] = [];
    render(<ConfirmDialogProvider><Ask variant="danger" onAnswer={(v) => answers.push(v)} /></ConfirmDialogProvider>);
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await screen.findByText('Sure?');
    // Focus starts on Cancel; Enter presses it.
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(answers).toEqual([false]));

    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await screen.findByText('Sure?');
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(screen.getByText('Sure?')).toBeInTheDocument();
    expect(answers).toEqual([false]);
  });
});

describe('Modal initial focus', () => {
  it('focuses the first field of the content, not the close button', () => {
    render(<Modal open onClose={vi.fn()} title="Rename"><input aria-label="Name" /></Modal>);
    expect(document.activeElement).toBe(screen.getByLabelText('Name'));
  });

  it('falls back to the footer, then to the close button', () => {
    render(<Modal open onClose={vi.fn()} title="Info" footer={<button>OK</button>}><p>Text only</p></Modal>);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'OK' }));
  });
});
