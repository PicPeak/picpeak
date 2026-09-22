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
