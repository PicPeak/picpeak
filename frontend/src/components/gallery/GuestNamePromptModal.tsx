import React, { useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Input } from '../common';
import { useGuestIdentity } from '../../contexts/GuestIdentityContext';

interface GuestNamePromptModalProps {
  requireEmail?: boolean;
  allowCancel?: boolean;
  onCancel?: () => void;
}

/**
 * Session-wide prompt shown in guest identity mode when no identity exists
 * yet. Triggered by `ensureIdentity()` on the first interactive feedback
 * attempt, or manually via `openPrompt()`.
 *
 * Includes a link to the recovery flow for users who already registered on
 * another device.
 */
export const GuestNamePromptModal: React.FC<GuestNamePromptModalProps> = ({
  requireEmail = false,
  allowCancel = true,
  onCancel,
}) => {
  const { t } = useTranslation();
  const { promptOpen, closePrompt, register, openRecovery } = useGuestIdentity();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  if (!promptOpen) return null;

  const handleClose = () => {
    setName('');
    setEmail('');
    setErrors({});
    setSubmitError(null);
    closePrompt();
    onCancel?.();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const newErrors: Record<string, string> = {};
    if (!name.trim()) {
      newErrors.name = t('gallery.guestPrompt.nameRequired', 'Name is required');
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      newErrors.email = t('gallery.guestPrompt.invalidEmail', 'Invalid email address');
    }
    if (requireEmail && !email.trim()) {
      newErrors.email = t('gallery.guestPrompt.emailRequired', 'Email is required');
    }
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    try {
      await register(name.trim(), email.trim() || undefined);
    } catch (err) {
      const error = err as { response?: { data?: { error?: string } } };
      setSubmitError(error.response?.data?.error || t('gallery.guestPrompt.error', 'Registration failed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black bg-opacity-50" onClick={allowCancel ? handleClose : undefined} />
      <div className="relative bg-surface rounded-lg shadow-xl max-w-md w-full p-6">
        {allowCancel && (
          <button
            type="button"
            onClick={handleClose}
            className="absolute top-4 right-4 p-1 hover:bg-black/10 rounded-lg transition-colors"
          >
            <X className="w-5 h-5 text-muted-theme" />
          </button>
        )}

        <h2 className="text-lg font-semibold text-theme mb-2">
          {t('gallery.guestPrompt.title', "Welcome — what's your name?")}
        </h2>
        <p className="text-sm text-muted-theme mb-4">
          {t(
            'gallery.guestPrompt.description',
            'Your picks will be saved under this name so the photographer knows which photos you love.'
          )}
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label={t('gallery.guestPrompt.nameLabel', 'Your name')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={errors.name}
            placeholder={t('gallery.guestPrompt.namePlaceholder', 'Enter your name')}
            autoFocus
            required
            maxLength={100}
          />
          <Input
            type="email"
            label={
              requireEmail
                ? t('gallery.guestPrompt.emailLabelRequired', 'Email')
                : t('gallery.guestPrompt.emailLabel', 'Email (optional)')
            }
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={errors.email}
            placeholder={t('gallery.guestPrompt.emailPlaceholder', 'you@example.com')}
            maxLength={255}
          />

          {submitError && (
            <div className="text-sm text-red-600 bg-red-50 dark:bg-red-900/20 rounded px-3 py-2">
              {submitError}
            </div>
          )}

          <div className="flex gap-2 pt-2">
            <Button type="submit" variant="primary" className="flex-1" disabled={submitting}>
              {submitting
                ? t('common.submitting', 'Submitting...')
                : t('gallery.guestPrompt.submit', 'Continue')}
            </Button>
            {allowCancel && (
              <Button type="button" variant="ghost" onClick={handleClose} disabled={submitting}>
                {t('common.cancel', 'Cancel')}
              </Button>
            )}
          </div>

          <button
            type="button"
            onClick={() => {
              closePrompt();
              openRecovery();
            }}
            className="text-sm text-accent hover:underline w-full text-center pt-2"
          >
            {t('gallery.guestPrompt.alreadyHere', "I've been here before")}
          </button>
        </form>
      </div>
    </div>
  );
};
