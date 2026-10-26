import React, { useRef, useState } from 'react';
import { Lock, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Input } from '../common';
import { useGalleryDialog } from './hooks/useGalleryDialog';

interface Props {
  onClose: () => void;
  onSubmit: (pin: string) => Promise<void>;
}

/** The gallery's themed PIN form; the server remains responsible for elevation. */
export const GalleryClientAccessDialog: React.FC<Props> = ({ onClose, onSubmit }) => {
  const { t } = useTranslation();
  const [pin, setPin] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  useGalleryDialog({ open: true, onClose, panelRef, initialFocusRef: inputRef, dismissible: !pending });

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999] p-4" onClick={() => { if (!pending) onClose(); }}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={t('clientAccess.manageGallery', 'Manage Gallery')}
        className="card-themed text-theme p-6 max-w-md w-full" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 mb-4">
          <h2 className="text-lg font-semibold text-theme">{t('clientAccess.manageGallery', 'Manage Gallery')}</h2>
          <button type="button" onClick={onClose} disabled={pending} aria-label={t('common.close', 'Close')}
            className="text-muted-theme hover:text-theme disabled:opacity-50"><X className="w-5 h-5" /></button>
        </div>
        <p className="text-sm text-muted-theme mb-4">{t('clientAccess.pinEntryDialogDescription', 'Enter your client PIN to open the client view, including hidden photos and client download options. Visibility changes affect what guests see.')}</p>
        <form className="space-y-4" onSubmit={async (e) => {
          e.preventDefault();
          if (submitting.current || !pin.trim()) return;
          submitting.current = true;
          setPending(true);
          setError(null);
          try { await onSubmit(pin); }
          catch (err: unknown) {
            const response = (err as { response?: { status?: number; data?: { code?: string } } }).response;
            const code = response?.data?.code;
            setError(response?.status === 423 ? t('clientAccess.pinEntryLocked', 'PIN entry is temporarily paused. Try again later or use your private client link.')
              : response?.status === 429 ? t('clientAccess.pinEntryBusy', 'PIN entry is busy. Please wait a moment and try again.')
              : code === 'CLIENT_ACCESS_UNAVAILABLE' ? t('clientAccess.entryUnavailable', 'PIN entry is no longer available for this gallery.')
              : response?.status === 401 && code ? t('clientAccess.sessionExpired', 'Your gallery session has ended. Reopen the gallery and try again.')
              : response?.status === 401 ? t('clientAccess.pinEntryInvalidPin', 'Invalid PIN. Please try again.')
              : t('clientAccess.pinEntryFailed', 'Client access could not be opened. Please try again.'));
          } finally { submitting.current = false; setPending(false); setPin(''); }
        }}>
          <Input ref={inputRef} themed type="password" label={t('clientAccess.pinLabel')}
            placeholder={t('clientAccess.pinPlaceholder')} autoComplete="current-password" value={pin}
            onChange={(e) => { setPin(e.target.value); setError(null); }} disabled={pending}
            leftIcon={<Lock className="w-4 h-4" />} />
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <Button type="submit" className="w-full gallery-btn" disabled={pending || !pin.trim()} isLoading={pending}>
            {t('clientAccess.loginButton')}
          </Button>
        </form>
      </div>
    </div>
  );
};
