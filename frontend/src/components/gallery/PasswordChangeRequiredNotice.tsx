import React from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Shown when a gallery admin preview is refused with 403 MUST_CHANGE_PASSWORD.
 *
 * The generic states around it are both wrong for this case: "failed to load"
 * offers a Retry that can never succeed, and "gallery not found" is untrue.
 * The admin area already handles the flag with a blocking password-change
 * dialog (AdminLayout), so this only has to send them there.
 *
 * The same notice covers a preview refused with 401 SESSION_TIMEOUT: the admin
 * session idled out, and the way back is signing in again.
 *
 * A plain link rather than a router navigation: the gallery applied its own
 * theme to the document, and a full load leaves it behind.
 */
export const PasswordChangeRequiredNotice: React.FC<{ reason?: 'password' | 'session' }> = ({ reason = 'password' }) => {
  const { t } = useTranslation();

  return (
    <div className="min-h-screen bg-surface flex items-center justify-center px-4">
      <div className="text-center max-w-md">
        <p className="text-lg text-muted-theme">
          {reason === 'session'
            ? t('gallery.adminSessionExpired', 'Your admin session has expired. Sign in again to preview this gallery.')
            : t('gallery.passwordChangeRequired', 'Change your password in the admin area before previewing this gallery.')}
        </p>
        {reason === 'session' ? (
          <a href="/admin/login" className="btn btn-primary btn-md inline-flex mt-4">
            {t('gallery.signInAgain', 'Sign in again')}
          </a>
        ) : (
          <a href="/admin" className="btn btn-primary btn-md inline-flex mt-4">
            {t('gallery.goToAdminArea', 'Go to admin area')}
          </a>
        )}
      </div>
    </div>
  );
};
