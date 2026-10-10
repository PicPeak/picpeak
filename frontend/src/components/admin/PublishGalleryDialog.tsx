import React, { useState } from 'react';
import { Send, Lock, Eye, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Input, Modal } from '../common';
import { GalleryRecipientsList } from './GalleryRecipientsList';

interface PublishGalleryDialogProps {
  eventName: string;
  requirePassword: boolean;
  /** Gets the standard gallery email — null when there is none, or it is also an assigned account. */
  inlineEmail?: string | null;
  /** WhatsApp recipient — publish notifies this too, so it counts as "someone gets told". */
  customerPhone?: string | null;
  /** Assigned customer accounts — each gets its portal email ("your galleries"). */
  accountNames?: string[];
  /** Portal-email accounts when their names are not visible. */
  accountCount?: number;
  /** Accounts this admin may not mail (customers.events). */
  skippedAccountCount?: number;
  isPublishing: boolean;
  onConfirm: (password?: string, notifyCustomer?: boolean) => void;
  onClose: () => void;
}

/**
 * Confirmation dialog for the "Publish & Notify" action on a draft gallery.
 *
 * When the gallery is password-protected, the admin re-types the password
 * here so the gallery_created email can carry the real plaintext instead of
 * the "(set at creation)" sentinel (#627). The backend also re-hashes what
 * the admin types so the stored hash matches what was just emailed — admins
 * who mistype at creation get a self-healing publish flow.
 *
 * For galleries without a password, the dialog is a plain confirm + Publish
 * button (mirrors the previous window.confirm() flow).
 */
export const PublishGalleryDialog: React.FC<PublishGalleryDialogProps> = ({
  eventName,
  requirePassword,
  inlineEmail,
  customerPhone,
  accountNames = [],
  accountCount = accountNames.length,
  skippedAccountCount = 0,
  isPublishing,
  onConfirm,
  onClose,
}) => {
  const { t } = useTranslation();
  // Someone gets notified if there's an inline email, an assigned account (the
  // account "your galleries" email), OR a phone — publish queues a WhatsApp
  // for that last one. Leaving the phone out hid the opt-out on phone-only
  // galleries AND told the admin nothing would be sent, while the WhatsApp
  // went out anyway.
  const willEmail = !!inlineEmail || accountCount > 0;
  const willNotify = willEmail || !!customerPhone;
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // Defaults to notifying — that is what publish has always done, and the
  // quiet path is the exception (#1235).
  const [notifyCustomer, setNotifyCustomer] = useState(true);
  // The password is only collected (and required) when the standard gallery
  // email goes out, because only that email carries it. The portal email to
  // assigned accounts never does — the portal opens the gallery without it.
  // Otherwise the field is hidden and the existing hash is kept, so a gallery
  // announced only to accounts can always be published. Unchecking "notify"
  // hides it for the same reason: nothing is being sent.
  const needsPassword = requirePassword && !!inlineEmail && notifyCustomer;

  const handleSubmit = () => {
    if (needsPassword) {
      if (!password || password.trim().length < 6) {
        setError(t('events.publishDialog.errorMinLength', 'Password must be at least 6 characters long.'));
        return;
      }
    }
    setError(undefined);
    onConfirm(needsPassword ? password : undefined, notifyCustomer);
  };

  return (
    <Modal
      open
      onClose={onClose}
      closeOnBackdrop={false}
      size="sm"
      title={t('events.publishDialog.title', 'Publish gallery')}
      footer={
      // Stack both buttons vertically (always). The German primary label
      // "Veröffentlichen & Kunden benachrichtigen" is ~40 chars including
      // the icon — at max-w-md, no side-by-side row layout fits it on one
      // line, and the base .btn class has @apply whitespace-nowrap (see
      // index.css:149) which overrides a whitespace-normal className via
      // CSS cascade order, so the text won't wrap either. Side-by-side
      // would silently push the button past the modal frame (#670).
      // col-reverse keeps the DOM order semantically secondary-then-primary
      // while putting the primary action visually on top — standard
      // confirmation-dialog pattern.
        <div className="w-full flex flex-col-reverse gap-3">
          <Button
            variant="outline"
            onClick={onClose}
            disabled={isPublishing}
          >
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={isPublishing}
            isLoading={isPublishing}
            leftIcon={willNotify && notifyCustomer ? <Send className="w-4 h-4" /> : undefined}
          >
            {willNotify && notifyCustomer
              ? t('events.publishAndNotify')
              : t('events.publishDialog.justPublish', 'Publish')}
          </Button>
        </div>
      }
    >
        <p className="text-soft mb-4">
          {/* Follows the checkbox. Left static it contradicted itself — the
              text promised an email to the customer while the box beneath it
              said none would be sent. */}
          {willNotify && !notifyCustomer
            ? t('events.publishDialog.descriptionQuiet', {
                eventName,
                defaultValue:
                  'Publishing "{{eventName}}" makes the gallery accessible. No email will be sent — you can send it later from this page.',
              })
            : willEmail
              ? t('events.publishDialog.descriptionNotify', {
                  eventName,
                  defaultValue: 'Publishing "{{eventName}}" makes the gallery accessible and notifies:',
                })
              : customerPhone
                ? t('events.publishDialog.descriptionWhatsapp', {
                    eventName,
                    defaultValue:
                      'Publishing "{{eventName}}" makes the gallery accessible. If WhatsApp is configured, the customer is notified there.',
                  })
                : t('events.publishDialog.descriptionNoEmail', {
                    eventName,
                    defaultValue:
                      'Publishing "{{eventName}}" makes the gallery accessible. No customer email is set, so no notification will be sent.',
                  })}
        </p>

        {(willEmail || skippedAccountCount > 0) && notifyCustomer && (
          <GalleryRecipientsList
            inlineEmail={inlineEmail ?? null}
            accountNames={accountNames}
            accountCount={accountCount}
            skippedAccountCount={skippedAccountCount}
            whatsappPhone={customerPhone}
            className="mb-4"
          />
        )}

        {willNotify && (
          <label className="flex items-start gap-3 mb-4 cursor-pointer">
            <input
              type="checkbox"
              checked={notifyCustomer}
              onChange={(e) => {
                setNotifyCustomer(e.target.checked);
                if (error) setError(undefined);
              }}
              className="mt-1 h-4 w-4 rounded border-line-strong"
            />
            <span className="text-sm">
              <span className="font-medium text-heading">
                {t('events.publishDialog.notifyLabel', 'Send the gallery email now')}
              </span>
              <span className="block text-soft">
                {t(
                  'events.publishDialog.notifyHelp',
                  'Uncheck to publish quietly — the gallery goes live and nothing is sent. You can send the email later from this page.',
                )}
              </span>
            </span>
          </label>
        )}

        {needsPassword && (
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
                'events.publishDialog.passwordHelp',
                'Re-type the password set at creation (or pick a new one). The email includes this exact text; the backend re-hashes it so the gallery login still works.',
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
    </Modal>
  );
};
