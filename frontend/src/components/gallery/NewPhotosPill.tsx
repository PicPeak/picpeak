import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** Live refresh (issue 1733, C5): "N new photos", click reloads the list. */
export function NewPhotosPill({ count, onClick }: { count: number; onClick: () => void }) {
  const { t } = useTranslation();
  return count > 0 ? (
    <div style={{ bottom: 'calc(1rem + var(--gallery-bottom-bar, 0px))' }} className="fixed left-1/2 -translate-x-1/2 z-40" role="status">
      <button
        type="button"
        onClick={onClick}
        className="flex items-center gap-2 rounded-full bg-text-primary px-4 py-2 min-h-[44px] text-sm text-background shadow-lg"
      >
        <RefreshCw className="w-4 h-4 shrink-0" aria-hidden="true" />
        <span>{t('gallery.newPhotos', '{{count}} new photos', { count })}</span>
      </button>
    </div>
  ) : null;
}
