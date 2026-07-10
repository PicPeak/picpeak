import React, { useState } from 'react';
import { X, ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Input } from '../common';
import { useGuestIdentity } from '../../contexts/GuestIdentityContext';

/**
 * Email-based identity recovery flow (Phase 3.2).
 *
 * Two steps:
 *   1) Enter email → server sends a 6-digit code.
 *   2) Enter code → server returns a guest token, identity restored.
 *
 * Opens when the user clicks "I've been here before" in the name prompt.
 */
export const GuestRecoveryModal: React.FC = () => {
  const { t } = useTranslation();
  const { recoveryOpen, closeRecovery, recoverRequest, recoverVerify, openPrompt } =
    useGuestIdentity();

  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  if (!recoveryOpen) return null;

  const reset = () => {
    setStep('email');
    setEmail('');
    setCode('');
    setSubmitting(false);
    setError(null);
    setInfo(null);
  };

  const handleClose = () => {
    reset();
    closeRecovery();
  };

  const backToPrompt = () => {
    reset();
    closeRecovery();
    openPrompt();
  };

  const handleRequestCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError(t('gallery.guestRecovery.invalidEmail', 'Enter a valid email address'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await recoverRequest(email.trim().toLowerCase());
      setInfo(t('gallery.guestRecovery.codeSent', 'Check your inbox for a verification code.'));
      setStep('code');
    } catch {
      setError(t('gallery.guestRecovery.requestError', 'Could not send code. Try again.'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(code.trim())) {
      setError(t('gallery.guestRecovery.invalidCode', 'Enter the 6-digit code'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await recoverVerify(email.trim().toLowerCase(), code.trim());
      // Success: context clears recoveryOpen on success, component will
      // unmount naturally.
    } catch {
      setError(t('gallery.guestRecovery.verifyError', 'Invalid or expired code.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black bg-opacity-50" onClick={handleClose} />
      <div className="relative bg-surface rounded-lg shadow-xl max-w-md w-full p-6">
        <button
          type="button"
          onClick={handleClose}
          className="absolute top-4 right-4 p-1 hover:bg-black/10 rounded-lg transition-colors"
        >
          <X className="w-5 h-5 text-muted-theme" />
        </button>

        <button
          type="button"
          onClick={backToPrompt}
          className="flex items-center gap-1 text-sm text-muted-theme hover:text-theme mb-3"
        >
          <ArrowLeft className="w-4 h-4" />
          {t('gallery.guestRecovery.back', 'Back')}
        </button>

        <h2 className="text-lg font-semibold text-theme mb-2">
          {t('gallery.guestRecovery.title', 'Recover your picks')}
        </h2>
        <p className="text-sm text-muted-theme mb-4">
          {step === 'email'
            ? t(
                'gallery.guestRecovery.emailStepDescription',
                'Enter the email you used before. We will send a 6-digit verification code.'
              )
            : t(
                'gallery.guestRecovery.codeStepDescription',
                'Enter the 6-digit code we sent to your email.'
              )}
        </p>

        {info && step === 'code' && (
          <div className="text-sm text-green-700 bg-green-50 dark:bg-green-900/20 rounded px-3 py-2 mb-3">
            {info}
          </div>
        )}
        {error && (
          <div className="text-sm text-red-600 bg-red-50 dark:bg-red-900/20 rounded px-3 py-2 mb-3">
            {error}
          </div>
        )}

        {step === 'email' ? (
          <form onSubmit={handleRequestCode} className="space-y-4">
            <Input
              type="email"
              label={t('gallery.guestRecovery.emailLabel', 'Email')}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoFocus
              required
            />
            <Button type="submit" variant="primary" className="w-full" disabled={submitting}>
              {submitting
                ? t('common.submitting', 'Submitting...')
                : t('gallery.guestRecovery.sendCode', 'Send code')}
            </Button>
          </form>
        ) : (
          <form onSubmit={handleVerify} className="space-y-4">
            <Input
              label={t('gallery.guestRecovery.codeLabel', 'Verification code')}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="123456"
              maxLength={6}
              autoFocus
              required
            />
            <Button type="submit" variant="primary" className="w-full" disabled={submitting}>
              {submitting
                ? t('common.submitting', 'Submitting...')
                : t('gallery.guestRecovery.verifyCode', 'Verify and continue')}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
};
