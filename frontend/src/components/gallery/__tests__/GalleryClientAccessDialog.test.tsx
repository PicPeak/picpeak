import React from 'react';
import { expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GalleryClientAccessDialog } from '../GalleryClientAccessDialog';

vi.mock('react-i18next', async () => ({
  ...await vi.importActual('react-i18next'),
  useTranslation: () => ({ t: (key: string, fallback?: unknown) => typeof fallback === 'string' ? fallback : key }),
}));

it('focuses the PIN, submits it without persisting it, and restores focus on close', async () => {
  const submit = vi.fn().mockResolvedValue(undefined);
  const user = userEvent.setup();
  const { rerender } = render(<button>opener</button>);
  screen.getByRole('button', { name: 'opener' }).focus();
  const close = vi.fn();
  rerender(<><button>opener</button><GalleryClientAccessDialog onClose={close} onSubmit={submit} /></>);
  const input = screen.getByLabelText('clientAccess.pinLabel');
  expect(input).toHaveFocus();
  await user.type(input, 'Client-Pin-2026!');
  await user.click(screen.getByRole('button', { name: 'clientAccess.loginButton' }));
  await waitFor(() => expect(submit).toHaveBeenCalledExactlyOnceWith('Client-Pin-2026!'));
  expect(input).toHaveValue('');
  await user.keyboard('{Escape}');
  expect(close).toHaveBeenCalledOnce();
  rerender(<button>opener</button>);
  expect(screen.getByRole('button', { name: 'opener' })).toHaveFocus();
});

it.each([
  [401, undefined, 'Invalid PIN. Please try again.'],
  [423, undefined, 'PIN entry is temporarily paused. Try again later or use your private client link.'],
  [429, undefined, 'PIN entry is busy. Please wait a moment and try again.'],
  [403, 'CLIENT_ACCESS_UNAVAILABLE', 'PIN entry is no longer available for this gallery.'],
  [401, 'TOKEN_REVOKED', 'Your gallery session has ended. Reopen the gallery and try again.'],
  [503, undefined, 'Client access could not be opened. Please try again.'],
])('handles HTTP %s (%s) without losing the dialog', async (status, code, message) => {
  const submit = vi.fn().mockRejectedValue({ response: { status, data: { code } } });
  render(<GalleryClientAccessDialog onClose={vi.fn()} onSubmit={submit} />);
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('clientAccess.pinLabel'), 'wrong');
  await user.click(screen.getByRole('button', { name: 'clientAccess.loginButton' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(message);
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(screen.getByLabelText('clientAccess.pinLabel')).toHaveValue('');
});
