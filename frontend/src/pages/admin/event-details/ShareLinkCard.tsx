import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { Copy, CheckCircle, Key, Mail, QrCode, Download, Eye, EyeOff } from 'lucide-react';
import type { Event } from '../../../types';
import { Button, Card } from '../../../components/common';
import { eventsService } from '../../../services/events.service';
import { buildShareLinkUrl } from '../../../utils/url';
import { isGalleryPublic } from '../../../utils/accessControl';

// Clipboard with the textarea/execCommand fallback for non-HTTPS installs
// (the documented http://host:3000/admin setup has no navigator.clipboard).
const copyText = async (text: string) => {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.style.position = 'fixed';
  textArea.style.left = '-999999px';
  textArea.style.top = '-999999px';
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  const successful = document.execCommand('copy');
  document.body.removeChild(textArea);
  if (!successful) {
    throw new Error('Copy failed');
  }
};

const saveBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

interface ShareLinkCardProps {
  event: Event;
  setShowPasswordReset: (show: boolean) => void;
  /** Bumped by the page after a password/PIN change (#1271). */
  passwordVersion?: number;
}

export const ShareLinkCard: React.FC<ShareLinkCardProps> = ({ event, setShowPasswordReset, passwordVersion = 0 }) => {
  const { t, i18n } = useTranslation();
  const [copiedLink, setCopiedLink] = useState(false);
  const [qrPreviewUrl, setQrPreviewUrl] = useState<string | null>(null);
  const [stored, setStored] = useState<{ password: string | null; client_password: string | null } | null>(null);
  const [loadingStored, setLoadingStored] = useState(false);
  const [copiedSecret, setCopiedSecret] = useState<string | null>(null);
  // Generation of the current reveal: a reset that lands while a reveal is
  // in flight must not have the late response bring the old password back.
  const revealGeneration = useRef(0);

  // #1271 — "Show password" only exists while the admin has opted into
  // recoverable storage in Settings → Security. Off is the default; the
  // button never renders for a plain install. Asked through the event
  // (not the settings API) so editors get the same answer as admins.
  const { data: recoverableStatus } = useQuery({
    queryKey: ['admin-event-password-status', event.id],
    queryFn: () => eventsService.getGalleryPasswordStatus(event.id),
  });
  const passwordRecoverable = recoverableStatus?.enabled === true;
  const hasSecret = !isGalleryPublic(event.require_password) || Boolean(event.client_access_enabled);

  // A password change (reset, edit) or an event switch drops the revealed
  // values — the copy on screen may no longer be the one that works.
  useEffect(() => { revealGeneration.current += 1; setStored(null); setLoadingStored(false); }, [event.id, passwordVersion]);

  const handleShowPassword = async () => {
    if (stored) { setStored(null); return; }
    const generation = ++revealGeneration.current;
    setLoadingStored(true);
    try {
      const result = await eventsService.getGalleryPassword(event.id);
      if (generation !== revealGeneration.current) return;
      setStored({ password: result.password, client_password: result.client_password });
    } catch {
      if (generation === revealGeneration.current) toast.error(t('events.failedToLoadPassword', 'Failed to load the stored password'));
    } finally {
      if (generation === revealGeneration.current) setLoadingStored(false);
    }
  };

  const copySecret = async (label: string, value: string) => {
    try {
      await copyText(value);
      setCopiedSecret(label);
      setTimeout(() => setCopiedSecret(null), 2000);
    } catch {
      toast.error(t('errors.copyFailed', 'Failed to copy link. Please copy manually.'));
    }
  };

  // QR preview (#836) — fetched as a blob because the admin API needs the
  // Bearer token; a plain <img src> would come back 401. The `stale` flag
  // guards the async gap: without it, a response landing after unmount or
  // an event switch would leak its object URL and could overwrite a newer
  // event's preview with the previous gallery's QR (codex review of #847).
  useEffect(() => {
    if (!event.share_link) return;
    let stale = false;
    let objectUrl: string | null = null;
    eventsService.getQrBlob(event.id, 'png', 300)
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        if (stale) {
          URL.revokeObjectURL(url);
          return;
        }
        objectUrl = url;
        setQrPreviewUrl(url);
      })
      .catch(() => {
        if (!stale) setQrPreviewUrl(null);
      });
    return () => {
      stale = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [event.id, event.share_link]);

  const handleQrDownload = async (kind: 'png' | 'svg' | 'table-card' | 'poster') => {
    try {
      if (kind === 'png' || kind === 'svg') {
        saveBlob(await eventsService.getQrBlob(event.id, kind, 1024), `qr-${event.slug}.${kind}`);
      } else {
        const lang = (i18n.language || 'en').split('-')[0];
        saveBlob(await eventsService.getQrPrintBlob(event.id, kind, lang), `qr-${kind}-${event.slug}.pdf`);
      }
    } catch {
      toast.error(t('errors.downloadFailed', 'Download failed'));
    }
  };

  const handleCopyLink = async () => {
    try {
      // Check if share_link exists
      if (!event.share_link) {
        toast.error(t('errors.noShareLink', 'No share link available'));
        return;
      }

      await copyText(buildShareLinkUrl(event.share_link));

      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
      toast.success(t('toast.linkCopied'));
    } catch (err) {
      console.error('Copy failed:', err);
      toast.error(t('errors.copyFailed', 'Failed to copy link. Please copy manually.'));
    }
  };

  return (
    <Card padding="md">
      <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">{t('events.shareLink')}</h2>

      {event.share_secrets_hidden ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {t('events.shareLinkOwnerOnly', 'Only the gallery owner can see and share this link.')}
        </p>
      ) : (
      <>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={buildShareLinkUrl(event.share_link)}
          readOnly
          className="flex-1 px-3 py-2 bg-neutral-50 dark:bg-neutral-700 border border-neutral-300 dark:border-neutral-600 text-neutral-900 dark:text-neutral-100 rounded-lg text-sm"
        />
        <Button
          variant="outline"
          size="md"
          leftIcon={copiedLink ? <CheckCircle className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
          onClick={handleCopyLink}
        >
          {copiedLink ? t('events.copied') : t('events.copy')}
        </Button>
      </div>

      <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-2">
        {isGalleryPublic(event.require_password)
          ? t('events.shareWithGuestsPublic', 'Anyone with this link can view the gallery. No password is required.')
          : t('events.shareWithGuests')}
      </p>
      </>
      )}

      {event.share_link && (
        <div className="mt-4 pt-4 border-t border-neutral-200 dark:border-neutral-700">
          <h3 className="text-sm font-medium text-neutral-900 dark:text-neutral-100 mb-3 flex items-center gap-2">
            <QrCode className="w-4 h-4" />
            {t('events.qrCode', 'QR code')}
          </h3>
          {/* Stacks on phones; downloads stay available even when the preview
              request failed — the section keys off share-link availability,
              not off a successfully loaded preview (codex review of #847). */}
          <div className="flex flex-col sm:flex-row items-start gap-4">
            {qrPreviewUrl ? (
              <img
                src={qrPreviewUrl}
                alt={t('events.qrCode', 'QR code')}
                className="w-28 h-28 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white p-1"
              />
            ) : (
              <div className="w-28 h-28 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-700 flex items-center justify-center">
                <QrCode className="w-8 h-8 text-neutral-300 dark:text-neutral-500" />
              </div>
            )}
            <div className="flex-1 w-full grid grid-cols-1 sm:grid-cols-2 gap-2">
              <Button variant="outline" size="sm" leftIcon={<Download className="w-4 h-4" />} onClick={() => handleQrDownload('png')}>
                PNG
              </Button>
              <Button variant="outline" size="sm" leftIcon={<Download className="w-4 h-4" />} onClick={() => handleQrDownload('svg')}>
                SVG
              </Button>
              <Button variant="outline" size="sm" leftIcon={<Download className="w-4 h-4" />} onClick={() => handleQrDownload('table-card')}>
                {t('events.qrTableCard', 'Table card (A6)')}
              </Button>
              <Button variant="outline" size="sm" leftIcon={<Download className="w-4 h-4" />} onClick={() => handleQrDownload('poster')}>
                {t('events.qrPoster', 'Poster (A4)')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {!event.is_archived && (
        <div className="mt-4 pt-4 border-t border-neutral-200 dark:border-neutral-700 space-y-2">
          {passwordRecoverable && hasSecret && (
            <>
              <Button
                variant="outline"
                size="sm"
                leftIcon={stored ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                onClick={handleShowPassword}
                isLoading={loadingStored}
                className="w-full justify-center"
                data-testid="show-gallery-password"
              >
                {stored ? t('events.hideGalleryPassword', 'Hide password') : t('events.showGalleryPassword', 'Show password')}
              </Button>
              {stored && (
                <div className="rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-700/50 p-3 space-y-2 text-sm" data-testid="stored-gallery-password">
                  {!stored.password && !stored.client_password ? (
                    <p className="text-neutral-600 dark:text-neutral-400">{t('events.galleryPasswordNotStored')}</p>
                  ) : (
                    ([
                      ['password', t('events.galleryPasswordLabel', 'Gallery password'), stored.password],
                      ['client_password', t('events.clientPinLabel', 'Client PIN'), stored.client_password],
                    ] as const).filter(([, , value]) => Boolean(value)).map(([key, label, value]) => (
                      <div key={key} className="flex items-center gap-2">
                        <span className="text-neutral-600 dark:text-neutral-400 shrink-0">{label}</span>
                        <code className="flex-1 min-w-0 truncate font-mono text-neutral-900 dark:text-neutral-100">{value}</code>
                        <button
                          type="button"
                          onClick={() => copySecret(key, value as string)}
                          className="p-1 text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
                          aria-label={`${t('events.copy')} ${label}`}
                        >
                          {copiedSecret === key ? <CheckCircle className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
                        </button>
                      </div>
                    ))
                  )}
                </div>
              )}
            </>
          )}
          <Button
            variant="outline"
            size="sm"
            leftIcon={<Key className="w-4 h-4" />}
            onClick={() => setShowPasswordReset(true)}
            className="w-full justify-center"
          >
            {t('events.resetGalleryPassword')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            leftIcon={<Mail className="w-4 h-4" />}
            onClick={async () => {
              try {
                await eventsService.resendCreationEmail(event.id);
                // #1262 — "queued" was being read as "delivered". Queueing only
                // writes an email_queue row; say where to look when it doesn't
                // turn up, because a queue nobody is working raises no failure.
                toast.success(`${t('events.creationEmailResent')} ${t('events.emailQueuedHint', 'The queue processor sends it — check System health if it does not arrive.')}`);
              } catch {
                toast.error(t('events.failedToResendEmail'));
              }
            }}
            className="w-full justify-center"
          >
            {t('events.resendCreationEmail')}
          </Button>
          {passwordRecoverable && hasSecret && (
            <p className="text-xs text-neutral-500 dark:text-neutral-400 text-center">{t('events.resendWithStoredPasswordHint')}</p>
          )}
        </div>
      )}
    </Card>
  );
};
