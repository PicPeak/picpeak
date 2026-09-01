import React, { useState } from 'react';
import { X, Mail, Lock, Eye, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Card, Input } from '../common';

interface SendGalleryEmailDialogProps {
  eventName: string;
  recipient: string;
  requirePassword: boolean;
  isSending: boolean;
  onConfirm: (password?: string) => void;
  onClose: () => void;
}

/**
 * Send the gallery email for an already-published gallery (#1235).
 *
 * It asks for the password for the same reason the publish dialog does (#627):
 * `password_hash` is a hash, so the plaintext only exists in the request the
 * admin types it into. Without it the email carries the "(set at creation)"
 * sentinel — and this action is most useful right after a quiet publish, which
 * is exactly the path that never collected a password. An email whose password
 * line reads "(set at creation)" cannot get the customer into the gallery, so
 * asking here is what makes the button do what its label promises.
 *
 * Galleries with no password skip the field entirely — there is nothing to
 * carry, and the email says so.
 */
export const SendGalleryEmailDialog: React.FC<SendGalleryEmailDialogProps> = ({
  eventName,
  recipient,
  requirePassword,
  isSending,
  onConfirm,
  onClose,
}) => {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const handleSubmit = () => {
    if (requirePassword) {
      if (!password || password.trim().length < 6) {
        setError(t('events.publishDialog.errorMinLength', 'Password must be at least 6 characters long.'));
        return;
      }
    }
    setError(undefined);
    onConfirm(requirePassword ? password : undefined);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <Card className="max-w-md w-full">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
            {t('events.sendGalleryEmail.title', 'Send gallery email')}
          </h2>
          <button
            onClick={onClose}
            className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
            aria-label={t('common.close', 'Close')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <p className="text-neutral-600 dark:text-neutral-400 mb-4">
          {t('events.sendGalleryEmail.description', {
            eventName,
            recipient,
            defaultValue: 'Sends the gallery link for "{{eventName}}" to {{recipient}}.',
          })}
        </p>

        {requirePassword && (
          <div className="space-y-3 mb-4">
            <Input
              type={showPassword ? 'text' : 'password'}
              label={t('events.publishDialog.passwordLabel', 'Gallery password')}
              placeholder={t('events.publishDialog.passwordPlaceholder', 'Enter the gallery password')}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (error) setError(undefined);
              }}
              error={error}
              helperText={t(
                'events.sendGalleryEmail.passwordHelp',
                'The email includes this exact text. Re-type the gallery password (or pick a new one) — the backend re-hashes it so the login still works.',
              )}
              leftIcon={<Lock className="w-5 h-5" />}
              rightIcon={
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="p-1"
                  aria-label={showPassword ? t('events.passwordReset.hide', 'Hide') : t('events.passwordReset.show', 'Show')}
                >
                  {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                </button>
              }
            />
          </div>
        )}

        <div className="flex flex-col-reverse gap-3">
          <Button variant="outline" onClick={onClose} disabled={isSending}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={isSending}
            isLoading={isSending}
            leftIcon={<Mail className="w-4 h-4" />}
          >
            {t('events.sendGalleryEmail.button', 'Send gallery email')}
          </Button>
        </div>
      </Card>
    </div>
  );
};
