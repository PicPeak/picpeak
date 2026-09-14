/**
 * The "confirm it's you" step in front of the public contract and quote pages.
 * Each server refusal has to tell the visitor what to do next.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  const interpolate = (s: string, o?: Record<string, unknown>) =>
    s.replace(/\{\{(\w+)\}\}/g, (_m, k) => String(o?.[k] ?? ''));
  return {
    ...actual,
    useTranslation: () => ({
      t: (k: string, fb?: unknown, opts?: Record<string, unknown>) => (typeof fb === 'string' ? interpolate(fb, opts) : k),
      i18n: { language: 'en', changeLanguage: () => Promise.resolve() },
    }),
  };
});

import { DocumentVerificationStep } from '../DocumentVerificationStep';

const refusal = (status: number, data: Record<string, unknown>) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });

function renderStep(overrides: Partial<React.ComponentProps<typeof DocumentVerificationStep>> = {}) {
  const props = {
    issuer: { companyName: 'Studio Nord' },
    emailHint: 'k***@example.com',
    isDark: false,
    requestCode: vi.fn().mockResolvedValue({ sent: true, emailHint: 'k***@example.com', resendAfterSeconds: 30 }),
    confirmCode: vi.fn().mockResolvedValue({ grant: 'grant-1', expiresInSeconds: 900 }),
    onVerified: vi.fn(),
    ...overrides,
  };
  render(<DocumentVerificationStep {...props} />);
  return props;
}

async function sendAndType(code: string) {
  fireEvent.click(screen.getByRole('button', { name: /send code/i }));
  const input = await screen.findByLabelText('6-digit code');
  fireEvent.change(input, { target: { value: code } });
  return input;
}

describe('DocumentVerificationStep', () => {
  it('explains why, shows no personal data beyond the masked address, and focuses the code input after sending', async () => {
    const props = renderStep();
    expect(screen.getByText(/k\*\*\*@example\.com/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /send code/i }));

    const input = await screen.findByLabelText('6-digit code');
    expect(props.requestCode).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(input).toHaveAttribute('autocomplete', 'one-time-code');
    expect(input).toHaveAttribute('inputmode', 'numeric');
  });

  it('hands the grant over after a correct code', async () => {
    const props = renderStep();
    await sendAndType('123456');

    fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }));

    await waitFor(() => expect(props.onVerified).toHaveBeenCalledWith({ grant: 'grant-1', expiresInSeconds: 900 }));
    expect(props.confirmCode).toHaveBeenCalledWith('123456');
  });

  it('says how many attempts are left after a wrong code', async () => {
    renderStep({
      confirmCode: vi.fn().mockRejectedValue(refusal(400, { code: 'VERIFICATION_CODE_INVALID', attemptsRemaining: 2 })),
    });
    await sendAndType('000000');

    fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('That code is not correct. 2 attempts remaining.');
  });

  it('asks to send a new code when the code has expired', async () => {
    renderStep({
      requestCode: vi.fn().mockResolvedValue({ sent: true, emailHint: null, resendAfterSeconds: 0 }),
      confirmCode: vi.fn().mockRejectedValue(refusal(410, { code: 'VERIFICATION_CODE_EXPIRED' })),
    });
    await sendAndType('123456');

    fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('This code has expired. Please send a new code.');
    expect(screen.getByRole('button', { name: 'Send a new code' })).toBeEnabled();
  });

  it('makes the visitor wait when codes are rate limited', async () => {
    renderStep({
      requestCode: vi.fn().mockRejectedValue(refusal(429, { code: 'VERIFICATION_RATE_LIMITED', retryAfterSeconds: 45 })),
    });

    fireEvent.click(screen.getByRole('button', { name: /send code/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Please wait 45 seconds before requesting another code.');
    expect(screen.getByRole('button', { name: /send a new code in 45 s/i })).toBeDisabled();
  });

  it('tells the visitor to contact the sender when there is no address to send to', async () => {
    renderStep({ requestCode: vi.fn().mockRejectedValue(refusal(409, { code: 'NO_RECIPIENT_EMAIL' })) });

    fireEvent.click(screen.getByRole('button', { name: /send code/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/contact the sender/);
  });
});
