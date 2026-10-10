import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
export function UploadProcessingNotice({ processing }: { processing: { complete: number; total: number } | null }) {
  const { t } = useTranslation();
  return processing ? (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-full bg-text-primary px-4 py-2 text-sm text-background shadow-lg" role="status">
      <Loader2 className="w-4 h-4 animate-spin shrink-0" />
      <span>
        {t('upload.processing')}{' '}
        {t('upload.processingProgress', {
          complete: processing.complete,
          total: processing.total,
        })}
      </span>
    </div>
  ) : null;
}
