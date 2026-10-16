/**
 * The focus trap wraps Tab around the controls that are focusable at the
 * time of the key press — including one enabled after the trap opened.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { useFocusTrap } from '../useFocusTrap';

const Dialog: React.FC<{ sendEnabled: boolean }> = ({ sendEnabled }) => {
  const trap = useFocusTrap(true);
  return (
    <div ref={trap}>
      <button type="button">Close</button>
      <button type="button">Cancel</button>
      <button type="button" disabled={!sendEnabled}>Send</button>
    </div>
  );
};

it('reaches a control enabled after the trap opened, then wraps', async () => {
  const user = userEvent.setup();
  const { rerender } = render(<Dialog sendEnabled={false} />);
  expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
  rerender(<Dialog sendEnabled />);
  await user.tab();
  expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole('button', { name: 'Send' })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
  await user.tab({ shift: true });
  expect(screen.getByRole('button', { name: 'Send' })).toHaveFocus();
});

const WithHiddenLast: React.FC = () => {
  const trap = useFocusTrap(true);
  return (
    <div ref={trap}>
      <button type="button">First</button>
      <button type="button">Last visible</button>
      <button type="button" className="hidden">Desktop only</button>
    </div>
  );
};

it('skips a control that is not rendered, so the wrap does not stall on it', async () => {
  // jsdom has no layout: stand in checkVisibility for a `hidden` class.
  const proto = HTMLElement.prototype as HTMLElement & { checkVisibility?: () => boolean };
  const original = proto.checkVisibility;
  proto.checkVisibility = function (this: HTMLElement) { return !this.closest('.hidden'); };
  try {
    const user = userEvent.setup();
    render(<WithHiddenLast />);
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Last visible' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
  } finally {
    if (original) proto.checkVisibility = original;
    else delete proto.checkVisibility;
  }
});
