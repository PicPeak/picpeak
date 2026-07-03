import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { Copy, CheckCircle, Key, Mail } from 'lucide-react';
import type { Event } from '../../../types';
import { Button, Card } from '../../../components/common';
import { eventsService } from '../../../services/events.service';
import { buildShareLinkUrl } from '../../../utils/url';
import { isGalleryPublic } from '../../../utils/accessControl';

interface ShareLinkCardProps {
  event: Event;
  setShowPasswordReset: (show: boolean) => void;
}

export const ShareLinkCard: React.FC<ShareLinkCardProps> = ({ event, setShowPasswordReset }) => {
  const { t } = useTranslation();
  const [copiedLink, setCopiedLink] = useState(false);

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
