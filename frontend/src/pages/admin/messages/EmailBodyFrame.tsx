import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { emailPreviewDocument } from '../../../utils/emailPreview';

export function EmailBodyFrame({ html }: { html: string }) {
  const { t } = useTranslation();
  // Matching the exact body prevents a changed message from inheriting the
  // previous one's permission, even before effects have a chance to run.
  const [allowedBody, setAllowedBody] = useState<string | null>(null);
  const allowRemoteImages = allowedBody === html;
  const document = useMemo(() => emailPreviewDocument(html, allowRemoteImages), [html, allowRemoteImages]);
  return (
    <div className="flex h-full flex-col">
      {!allowRemoteImages && (
        <div className="flex items-center justify-between gap-3 border-b border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200">
          <span>{t('messages.remoteContentBlocked')}</span>
          <button type="button" onClick={() => setAllowedBody(html)} className="shrink-0 font-medium text-accent-dark underline">
            {t('messages.loadRemoteContent')}
          </button>
        </div>
      )}
      <iframe title={t('messages.emailBody')} sandbox="" referrerPolicy="no-referrer"
        srcDoc={document} className="min-h-0 w-full flex-1 border-0" />
    </div>
  );
}
