import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { Copy, CheckCircle, Key, Mail, QrCode, Download } from 'lucide-react';
import type { Event } from '../../../types';
import { Button, Card } from '../../../components/common';
import { eventsService } from '../../../services/events.service';
import { buildShareLinkUrl } from '../../../utils/url';
import { isGalleryPublic } from '../../../utils/accessControl';

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
}

export const ShareLinkCard: React.FC<ShareLinkCardProps> = ({ event, setShowPasswordReset }) => {
  const { t, i18n } = useTranslation();
  const [copiedLink, setCopiedLink] = useState(false);
  const [qrPreviewUrl, setQrPreviewUrl] = useState<string | null>(null);

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

      const shareUrl = buildShareLinkUrl(event.share_link);

      // Try modern clipboard API first
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(shareUrl);
      } else {
        // Fallback for non-HTTPS contexts or older browsers
        const textArea = document.createElement('textarea');
        textArea.value = shareUrl;
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
      }

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
                toast.success(t('events.creationEmailResent'));
              } catch {
                toast.error(t('events.failedToResendEmail'));
              }
            }}
            className="w-full justify-center"
          >
            {t('events.resendCreationEmail')}
          </Button>
        </div>
      )}
    </Card>
  );
};
