/**
 * The shared contract dialog keeps the focus while its parent re-renders
 * with a new inline onClose, and gives it back to the opener when it closes.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React, { useState } from 'react';
import { vi } from 'vitest';
import { ContractModal } from '../ContractModal';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_k: string, fb: string) => fb }) }));

const Host: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(0);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open</button>
      {open && (
        <ContractModal titleId="t" title="Dialog" onClose={() => setOpen(false)}>
          <button type="button" onClick={() => setCount((n) => n + 1)}>Bump {count}</button>
        </ContractModal>
      )}
    </>
  );
};

it('re-renders keep the focus in the dialog; closing returns it to the opener', async () => {
  const user = userEvent.setup();
  render(<Host />);
  const opener = screen.getByRole('button', { name: 'Open' });
  await user.click(opener);
  const bump = screen.getByRole('button', { name: /Bump/ });
  await user.click(bump);
  expect(screen.getByRole('button', { name: 'Bump 1' })).toHaveFocus();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(opener).toHaveFocus();
});
