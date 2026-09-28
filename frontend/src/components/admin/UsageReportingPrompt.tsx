import { useEffect, useId, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { usePermissions } from '../../contexts/PermissionsContext';
import { productUsageService } from '../../services/productUsage.service';
import { ProductUsageConsentDialog } from '../../features/settings/components/ProductUsageConsentDialog';
import { Button } from '../common/Button';
import { UsageReportingPoints } from './UsageReportingPitch';

/** The invitation is acknowledged once per installation; consent is a separate, explicit choice. */
export default function UsageReportingPrompt() {
  const { t } = useTranslation();
  const { hasPermission } = usePermissions();
  const queryClient = useQueryClient();
  const [hidden, setHidden] = useState(false);
  const [showConsent, setShowConsent] = useState(false);
  const [isEnabling, setIsEnabling] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  const { data } = useQuery({
    queryKey: ['productUsage'],
    queryFn: productUsageService.status,
    enabled: hasPermission('settings.edit'),
  });
  const visible = hasPermission('settings.edit') && !hidden && data?.status === 'disabled' && !data.prompt_shown;
  useEffect(() => {
    if (!visible) return;
    const dialog = ref.current;
    const opener = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    dialog?.focus();
    return () => {
      dialog?.close();
      if (opener?.isConnected) opener.focus();
    };
  }, [visible]);

  const dismiss = async () => {
    setHidden(true);
    try {
      queryClient.setQueryData(['productUsage'], await productUsageService.promptSeen());
    } catch {
      /* A failed acknowledgement may be offered again on a later visit. */
    }
  };

  const enable = async () => {
    setIsEnabling(true);
    try {
      queryClient.setQueryData(['productUsage'], await productUsageService.enable());
      toast.success(t('setup.usageReporting.enabled'));
      setHidden(true);
    } catch {
      toast.warn(t('setup.usageReporting.enableFailed'));
    } finally {
      setIsEnabling(false);
    }
  };

  if (!visible || !data) return null;

  return (
    <>
      <dialog
        ref={ref}
        tabIndex={-1}
        aria-labelledby={titleId}
        onCancel={(event) => {
          event.preventDefault();
          if (!isEnabling) void dismiss();
        }}
        className="w-[calc(100%-2rem)] max-w-md max-h-[90vh] flex flex-col overflow-hidden rounded-xl p-0 bg-panel text-heading shadow-xl backdrop:bg-black/50 focus:outline-none"
      >
        <header className="px-6 pt-6 pb-4">
          <h2 id={titleId} className="text-lg font-semibold text-heading mb-1">
            {t('productUsagePrompt.title')}
          </h2>
          <p className="text-sm text-soft">{t('productUsagePrompt.intro')}</p>
        </header>

        <div tabIndex={0} role="group" aria-label={t('productUsagePrompt.title')}
          className="min-h-0 overflow-y-auto px-6 py-2 focus-visible:outline-primary-600">
          <UsageReportingPoints />
        </div>

        <footer className="px-6 pt-4 pb-6 space-y-3">
          {data.collector_error && (
            <p role="alert" className="text-sm text-body">{t('setup.usageReporting.enableFailed')}</p>
          )}
          <Button type="button" size="lg" className="w-full h-auto min-h-12 whitespace-normal"
            isLoading={isEnabling} disabled={!data.collector_url} onClick={() => setShowConsent(true)}>
            {t('productUsage.review')}
          </Button>
          <Button type="button" variant="outline" size="lg" className="w-full h-auto min-h-12 whitespace-normal"
            disabled={isEnabling} onClick={dismiss}>
            {t('setup.usageReporting.skip')}
          </Button>
        </footer>
      </dialog>
      {showConsent && data.collector_url && (
        <ProductUsageConsentDialog
          collector={data.collector_url}
          busy={isEnabling}
          close={() => setShowConsent(false)}
          enable={enable}
        />
      )}
    </>
  );
}
