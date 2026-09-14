/**
 * "Confirm it's you" step for the public contract and quote pages.
 *
 * A contract or quote link is a bearer secret that travels through email
 * forwards, shared inboxes and browser history. Before the page shows the
 * customer's personal data or accepts a signature, the visitor asks for a
 * 6-digit code that goes to the customer's address on file and enters it here;
 * the server exchanges a correct code for a short-lived access grant.
 *
 * Only the issuer's branding is known at this point, so that is all the step
 * shows. The data calls come in as props so the step stays independent of the
 * document type.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Mail, ShieldCheck } from 'lucide-react';
import type { DocumentAccessGrant, DocumentVerificationSent } from '../../utils/documentAccess';

export interface DocumentVerificationIssuer {
  companyName: string | null;
  logoUrl?: string | null;
  logoUrlDark?: string | null;
}

interface DocumentVerificationStepProps {
  issuer: DocumentVerificationIssuer | null;
  /** Masked recipient address from the server, e.g. `k***@example.com`. */
  emailHint: string | null;
  isDark: boolean;
  /** Shown above the explanation, e.g. when the grant ran out mid-visit. */
  notice?: string | null;
  requestCode: () => Promise<DocumentVerificationSent>;
  confirmCode: (code: string) => Promise<DocumentAccessGrant>;
  onVerified: (access: DocumentAccessGrant) => void;
}

interface VerificationErrorBody {
  code?: string;
  attemptsRemaining?: number;
  retryAfterSeconds?: number;
}

const errorBody = (err: unknown): VerificationErrorBody =>
  (err as { response?: { data?: VerificationErrorBody } } | null)?.response?.data || {};

export const DocumentVerificationStep: React.FC<DocumentVerificationStepProps> = ({
  issuer, emailHint, isDark, notice, requestCode, confirmCode, onVerified,
}) => {
  const { t } = useTranslation();
  const [sent, setSent] = useState(false);
  const [hint, setHint] = useState<string | null>(emailHint);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waitSeconds, setWaitSeconds] = useState(0);
  const codeInputRef = useRef<HTMLInputElement>(null);

  // Countdown for the resend button, driven by the server's resend/retry hint.
  useEffect(() => {
    if (waitSeconds <= 0) return undefined;
    const timer = window.setTimeout(() => setWaitSeconds((s) => Math.max(0, s - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [waitSeconds]);

  // The code arrives by email; put the cursor where it goes.
  useEffect(() => {
    if (sent) codeInputRef.current?.focus();
  }, [sent]);

  const rateLimitedMessage = (seconds: number) => t(
    'documentVerification.errors.rateLimited',
    'Please wait {{seconds}} seconds before requesting another code.',
    { seconds },
  ) as string;
  const genericMessage = () => t('documentVerification.errors.generic', 'Something went wrong. Please try again.') as string;

  async function handleSend() {
    setBusy(true);
    setError(null);
    try {
      const result = await requestCode();
      if (result.emailHint) setHint(result.emailHint);
      setCode('');
      setWaitSeconds(Math.max(0, Number(result.resendAfterSeconds) || 0));
      if (sent) codeInputRef.current?.focus();
      setSent(true);
    } catch (err) {
      const body = errorBody(err);
      switch (body.code) {
        case 'VERIFICATION_RATE_LIMITED': {
          const seconds = Math.max(1, Number(body.retryAfterSeconds) || 60);
          setWaitSeconds(seconds);
          setError(rateLimitedMessage(seconds));
          // A code already went out for this link, maybe before a reload
          // reset this page. Let the visitor enter it instead of leaving them
          // in front of a disabled button.
          setSent(true);
          break;
        }
        case 'NO_RECIPIENT_EMAIL':
          setError(t('documentVerification.errors.noRecipientEmail',
            'There is no email address on file to send a code to. Please contact the sender.') as string);
          break;
        case 'EMAIL_UNAVAILABLE':
          setError(t('documentVerification.errors.emailUnavailable',
            'The code could not be sent right now. Please try again later or contact the sender.') as string);
          break;
        default:
          setError(genericMessage());
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirm(e: React.FormEvent) {
    e.preventDefault();
    const normalized = code.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(normalized)) {
      setError(t('documentVerification.errors.codeFormat', 'Enter the 6-digit code from the email.') as string);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const access = await confirmCode(normalized);
      onVerified(access);
    } catch (err) {
      const body = errorBody(err);
      switch (body.code) {
        case 'VERIFICATION_CODE_INVALID':
          setError(typeof body.attemptsRemaining === 'number'
            ? t('documentVerification.errors.invalid', 'That code is not correct. {{count}} attempts remaining.',
              { count: body.attemptsRemaining }) as string
            : t('documentVerification.errors.invalidNoCount', 'That code is not correct.') as string);
          break;
        case 'VERIFICATION_CODE_EXPIRED':
          setCode('');
          setError(t('documentVerification.errors.expired', 'This code has expired. Please send a new code.') as string);
          break;
        case 'VERIFICATION_TOO_MANY_ATTEMPTS':
          setCode('');
          setError(t('documentVerification.errors.tooManyAttempts',
            'Too many incorrect attempts. Please send a new code.') as string);
          break;
        case 'VERIFICATION_RATE_LIMITED': {
          const seconds = Math.max(1, Number(body.retryAfterSeconds) || 60);
          setWaitSeconds(seconds);
          setError(rateLimitedMessage(seconds));
          break;
        }
        default:
          setError(genericMessage());
      }
      codeInputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  const logo = isDark
    ? (issuer?.logoUrlDark || issuer?.logoUrl)
    : (issuer?.logoUrl || issuer?.logoUrlDark);
  const resendLabel = waitSeconds > 0
    ? t('documentVerification.resendIn', 'Send a new code in {{seconds}} s', { seconds: waitSeconds })
    : t('documentVerification.resend', 'Send a new code');

  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100">
      <div className="max-w-md mx-auto py-12 px-4">
        <div className="text-center mb-6">
          {logo && (
            <img src={logo} alt={issuer?.companyName || 'Logo'} className="mx-auto mb-3 h-16 object-contain" />
          )}
          {issuer?.companyName && <h2 className="text-xl font-bold">{issuer.companyName}</h2>}
        </div>

        <div className="bg-white dark:bg-neutral-800 rounded-xl shadow-sm border border-neutral-200 dark:border-neutral-700 p-6">
          <div className="flex items-center gap-2 mb-3">
            <ShieldCheck className="w-5 h-5" />
            <h1 className="text-lg font-semibold">{t('documentVerification.title', "Confirm it's you")}</h1>
          </div>

          {notice && <p className="text-sm text-amber-700 dark:text-amber-300 mb-3">{notice}</p>}

          <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
            {hint
              ? t('documentVerification.explanation',
                "To protect your personal data, please confirm it's you. We'll email a 6-digit code to {{email}}.",
                { email: hint })
              : t('documentVerification.explanationNoHint',
                "To protect your personal data, please confirm it's you. We'll email a 6-digit code to the address this link was sent to.")}
          </p>

          {error && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400 mb-3">{error}</p>
          )}

          {!sent ? (
            <button
              type="button"
              onClick={handleSend}
              disabled={busy || waitSeconds > 0}
              className="w-full inline-flex justify-center items-center gap-2 px-4 py-2 rounded-md bg-accent-dark text-white text-sm hover:opacity-90 disabled:opacity-50"
            >
              <Mail className="w-4 h-4" />
              {busy
                ? t('documentVerification.sending', 'Sending…')
                : waitSeconds > 0 ? resendLabel : t('documentVerification.sendCode', 'Send code')}
            </button>
          ) : (
            <form onSubmit={handleConfirm} className="space-y-3">
              <p className="text-sm text-neutral-700 dark:text-neutral-300">
                {hint
                  ? t('documentVerification.codeSent', 'We sent a code to {{email}}.', { email: hint })
                  : t('documentVerification.codeSentNoHint', 'We sent you a code by email.')}
              </p>
              <div>
                <label htmlFor="document-verification-code" className="block text-sm font-medium mb-1">
                  {t('documentVerification.codeLabel', '6-digit code')}
                </label>
                <input
                  id="document-verification-code"
                  ref={codeInputRef}
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]*"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 text-lg tracking-widest text-center font-mono text-neutral-900 dark:text-neutral-100"
                />
              </div>
              <button
                type="submit"
                disabled={busy || code.length !== 6}
                className="w-full px-4 py-2 rounded-md bg-accent-dark text-white text-sm hover:opacity-90 disabled:opacity-50"
              >
                {busy ? t('documentVerification.confirming', 'Checking…') : t('documentVerification.confirm', 'Confirm')}
              </button>
              <button
                type="button"
                onClick={handleSend}
                disabled={busy || waitSeconds > 0}
                className="w-full text-sm text-neutral-600 dark:text-neutral-400 hover:underline disabled:opacity-50 disabled:no-underline"
              >
                {resendLabel}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
