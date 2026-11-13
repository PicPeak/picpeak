import React, { useRef, useState } from 'react';
import { Camera, Info, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../common';
import { galleryService } from '../../services/gallery.service';
import { useGalleryDialog } from './hooks/useGalleryDialog';

/**
 * Find my photos with a selfie (issue 2355).
 *
 * The guest picks one selfie and must tick the consent box; the server checks
 * the box too. The selfie is sent once and kept nowhere, and the dialog says
 * so before anything is uploaded. A search with matches hands the photo ids
 * to the gallery, which shows them as a filter; one without keeps the dialog
 * open so the guest can try another selfie.
 */

interface SelfieSearchDialogProps {
  open: boolean;
  onClose: () => void;
  slug: string;
  onResult: (photoIds: number[]) => void;
}

const ERROR_KEYS: Record<string, [string, string]> = {
  SELFIE_NO_FACE: ['gallery.selfie.errorNoFace', 'No face was found in this photo. Try a selfie with your face clearly visible.'],
  SELFIE_INVALID: ['gallery.selfie.errorInvalid', 'This file could not be read. Please choose a photo.'],
  SELFIE_TOO_LARGE: ['gallery.selfie.errorTooLarge', 'This photo is too large. Please choose one under 15 MB.'],
  SELFIE_SEARCH_RATE_LIMITED: ['gallery.selfie.errorRateLimited', 'Too many searches. Please try again in a few minutes.'],
  SELFIE_SEARCH_UNAVAILABLE: ['gallery.selfie.errorUnavailable', 'The search is not available right now. Please try again later.'],
};

export const SelfieSearchDialog: React.FC<SelfieSearchDialogProps> = ({ open, onClose, slug, onResult }) => {
  const { t } = useTranslation();
  const [file, setFile] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = () => {
    if (busy) return;
    setFile(null);
    setConsent(false);
    setMessage(null);
    onClose();
  };
  useGalleryDialog({ open, onClose: close, panelRef });

  if (!open) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file || !consent || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const ids = await galleryService.searchBySelfie(slug, file, consent);
      if (ids.length === 0) {
        setMessage(t('gallery.selfie.noMatches', {
          defaultValue: 'We found no photos of you. Try another selfie with your face clearly visible.',
        }));
        return;
      }
      onResult(ids);
      setFile(null);
      setConsent(false);
      onClose();
    } catch (err: any) {
      const code = err?.response?.data?.code as string | undefined;
      const [key, fallback] = (code && ERROR_KEYS[code])
        || ['gallery.selfie.errorGeneric', 'The search failed. Please try again.'];
      setMessage(t(key, { defaultValue: fallback }));
    } finally {
      setBusy(false);
    }
  };

  const inputStyle = { color: 'var(--color-text)' };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={close} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="selfie-search-title"
        className="relative w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl shadow-xl max-h-[90vh] overflow-y-auto"
        style={{ backgroundColor: 'var(--color-surface)', color: 'var(--color-text)' }}
      >
        <div
          className="flex items-center justify-between px-4 pt-4 pb-3 border-b"
          style={{ borderColor: 'var(--color-surface-border)' }}
        >
          <h2 id="selfie-search-title" className="text-base font-medium">
            {t('gallery.selfie.title', { defaultValue: 'Find my photos' })}
          </h2>
          <button
            type="button"
            onClick={close}
            aria-label={t('common.close', { defaultValue: 'Close' })}
            className="p-2 -m-2 opacity-60 hover:opacity-100 transition-opacity"
            style={inputStyle}
          >
            <X size={20} />
          </button>
        </div>

        <form onSubmit={submit} className="px-4 py-4 space-y-4">
          <p className="text-sm">
            {t('gallery.selfie.intro', {
              defaultValue: 'Choose a selfie and we show the photos in this gallery that you appear in.',
            })}
          </p>

          <label className="block">
            <span className="block text-sm font-medium mb-1">
              {t('gallery.selfie.fileLabel', { defaultValue: 'Your selfie' })}
            </span>
            <input
              type="file"
              accept="image/*"
              onChange={(e) => { setFile(e.target.files?.[0] || null); setMessage(null); }}
              className="block w-full text-sm"
              style={inputStyle}
            />
          </label>

          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              className="mt-1 rounded"
            />
            <span className="text-sm">
              {t('gallery.selfie.consent', {
                defaultValue: 'I agree that my selfie is compared with the faces in this gallery to find my photos. I only search for myself.',
              })}
            </span>
          </label>

          <div className="flex gap-2 text-xs" style={{ color: 'var(--color-muted-text)' }}>
            <Info size={14} className="shrink-0 mt-0.5" aria-hidden />
            <span>
              {t('gallery.selfie.privacy', {
                defaultValue: 'Your selfie is used for this one search and deleted right away. Nothing is saved. Results can include photos of people who look like you and can miss some of yours.',
              })}
            </span>
          </div>

          {message && (
            <p role="alert" className="text-sm" style={{ color: 'var(--color-text)' }}>
              {message}
            </p>
          )}

          <Button
            type="submit"
            variant="primary"
            className="w-full"
            disabled={!file || !consent}
            isLoading={busy}
            leftIcon={<Camera size={16} aria-hidden />}
          >
            {busy
              ? t('gallery.selfie.searching', { defaultValue: 'Searching…' })
              : t('gallery.selfie.submit', { defaultValue: 'Find my photos' })}
          </Button>
        </form>
      </div>
    </div>
  );
};
