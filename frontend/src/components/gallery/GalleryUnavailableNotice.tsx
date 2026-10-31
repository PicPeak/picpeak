import { Clock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../common';

export function GalleryUnavailableNotice() {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <div className="max-w-md text-center" role="status">
        <Clock className="w-10 h-10 mx-auto mb-4 text-muted-theme" aria-hidden="true" />
        <h1 className="text-xl font-semibold text-theme">{t('gallery.temporarilyUnavailable', 'This gallery is temporarily unavailable.')}</h1>
        <p className="mt-3 text-muted-theme">{t('gallery.temporarilyUnavailableHelp', 'Please try again later. Your gallery link will stay the same.')}</p>
        <Button className="mt-5" onClick={() => window.location.reload()}>{t('gallery.tryAgain')}</Button>
      </div>
    </div>
  );
}
