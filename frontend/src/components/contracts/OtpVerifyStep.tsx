/**
 * Confirm the signer's email (#1446): send a six-digit code to the address
 * the link was sent to, then enter it. A correct code opens a signing
 * session, handed to `onVerified`.
 *
 * Link-level problems (the link was replaced, has expired, or the contract
 * was withdrawn) go to `onLinkError` so the page can show its own message.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Mail } from 'lucide-react';
import {
  publicContractSigningService,
  signingErrorCode,
  signingErrorStatus,
  type SigningSession,
} from '../../services/publicContractSigning.service';

const LINK_ERROR_CODES = new Set([
  'SIGNING_LINK_INVALID', 'SIGNING_LINK_REVOKED', 'SIGNING_LINK_EXPIRED', 'CONTRACT_WITHDRAWN',
]);

interface OtpVerifyStepProps {
  token: string;
  /** The masked address from the invite, shown before a code is sent. */
  maskedEmail: string;
  onVerified: (session: SigningSession) => void;
  onLinkError?: (code: string) => void;
}

export const OtpVerifyStep: React.FC<OtpVerifyStepProps> = ({ token, maskedEmail, onVerified, onLinkError }) => {
  const { t } = useTranslation();
  const [sent, setSent] = useState<{ maskedEmail: string; ttlMinutes: number } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);

  function linkProblem(err: unknown): boolean {
    const errCode = signingErrorCode(err);
    if (errCode && LINK_ERROR_CODES.has(errCode) && onLinkError) {
      onLinkError(errCode);
      return true;
    }
    return false;
  }

  function describeError(err: unknown): string {
    const errCode = signingErrorCode(err);
    switch (errCode) {
      case 'OTP_WRONG':
        return t('contractSigning.otp.errors.wrong', 'That code isn\'t right. Check the latest email and enter the six digits again.');
      case 'OTP_EXPIRED':
        return t('contractSigning.otp.errors.expired', 'This code has expired or was already used. Send a new code.');
      case 'OTP_LOCKED':
        return t('contractSigning.otp.errors.locked', 'Too many wrong tries for this code. Send a new code.');
      case 'OTP_RATE_LIMITED':
        return t('contractSigning.otp.errors.rateLimited', 'You have asked for several codes in the last hour. Use the latest code from your email, or try again in an hour.');
      default:
        break;
    }
    if (signingErrorStatus(err) === 429) {
      return t('contractSigning.otp.errors.tooManyRequests', 'Too many attempts from this connection. Wait a few minutes, then try again.');
    }
    if (!signingErrorStatus(err)) {
      return t('contractSigning.otp.errors.network', 'We couldn\'t reach the server. Check your connection and try again.');
    }
    return t('contractSigning.otp.errors.generic', 'Something went wrong. Try again; if it keeps happening, contact the sender.');
  }

  async function handleSend() {
    setSending(true);
    setError(null);
    try {
      const result = await publicContractSigningService.requestCode(token);
      setSent(result);
      setCode('');
    } catch (err) {
      if (!linkProblem(err)) setError(describeError(err));
    } finally {
      setSending(false);
    }
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      setError(t('contractSigning.otp.errors.format', 'Enter the six-digit code from the email.'));
      return;
    }
    setVerifying(true);
    setError(null);
    try {
      const session = await publicContractSigningService.verify(token, code);
      onVerified(session);
    } catch (err) {
      if (!linkProblem(err)) setError(describeError(err));
    } finally {
      setVerifying(false);
    }
  }

  const email = sent?.maskedEmail || maskedEmail;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Mail className="w-5 h-5" />
          {t('contractSigning.otp.title', 'Confirm your email address')}
        </h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
          {t('contractSigning.otp.intro', 'Before you can read and sign the contract, we send a six-digit code to {{email}}.', { email })}
        </p>
      </div>

      {!sent ? (
        <button
          type="button"
          onClick={handleSend}
          disabled={sending}
          className="px-4 py-2 rounded-md bg-accent-dark text-white text-sm hover:opacity-90 disabled:opacity-50"
        >
          {sending
            ? t('contractSigning.otp.sending', 'Sending…')
            : t('contractSigning.otp.send', 'Send code')}
        </button>
      ) : (
        <form onSubmit={handleVerify} className="space-y-3" noValidate>
          <p className="text-sm text-neutral-700 dark:text-neutral-300" role="status">
            {t('contractSigning.otp.sent', 'We sent a code to {{email}}. It can take up to a minute to arrive and is valid for {{minutes}} minutes.', {
              email: sent.maskedEmail, minutes: sent.ttlMinutes,
            })}
          </p>
          <div>
            <label htmlFor="contract-signing-code" className="block text-sm font-medium mb-1">
              {t('contractSigning.otp.codeLabel', 'Six-digit code')}
            </label>
            <input
              id="contract-signing-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              aria-invalid={error ? 'true' : undefined}
              aria-describedby={error ? 'contract-signing-code-error' : undefined}
              className="w-40 px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 text-lg tracking-[0.3em] font-mono text-neutral-900 dark:text-neutral-100"
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={verifying || code.length !== 6}
              className="px-4 py-2 rounded-md bg-accent-dark text-white text-sm hover:opacity-90 disabled:opacity-50"
            >
              {verifying
                ? t('contractSigning.otp.verifying', 'Checking…')
                : t('contractSigning.otp.verify', 'Confirm code')}
            </button>
            <button
              type="button"
              onClick={handleSend}
              disabled={sending}
              className="text-sm underline text-neutral-700 dark:text-neutral-300 disabled:opacity-50"
            >
              {t('contractSigning.otp.resend', 'Send a new code')}
            </button>
          </div>
        </form>
      )}

      {error && (
        <p id="contract-signing-code-error" role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
};
