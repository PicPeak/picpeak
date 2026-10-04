/**
 * The reset modal reports what the server did with the notification, not
 * what the admin ticked (issue 1733): POST /reset-password answers 200 with
 * `emailSent: false` when the event has no address or the queue write
 * failed, and the admin must not be told the customer was emailed.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PasswordResetModal } from '../PasswordResetModal';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const reset = async (emailSent: boolean) => {
  const onConfirm = vi.fn().mockResolvedValue({ newPassword: 'generated-pw', emailSent });
  render(<PasswordResetModal eventName="Summer" onConfirm={onConfirm} onClose={() => {}} />);
  fireEvent.click(screen.getByText('events.passwordReset.submit'));
  await waitFor(() => expect(screen.getByText('events.passwordReset.successHeading')).toBeInTheDocument());
  expect(onConfirm).toHaveBeenCalledWith(true, undefined);
};

describe('PasswordResetModal — email outcome', () => {
  it('shows the sent note only when the server queued the mail', async () => {
    await reset(true);
    expect(screen.getByText('events.passwordReset.emailSentNote')).toBeInTheDocument();
    expect(screen.queryByText('events.passwordReset.emailNotSentNote')).not.toBeInTheDocument();
  });

  it('says that no mail went out when emailSent is false despite the ticked option', async () => {
    await reset(false);
    expect(screen.queryByText('events.passwordReset.emailSentNote')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('events.passwordReset.emailNotSentNote');
  });
});
