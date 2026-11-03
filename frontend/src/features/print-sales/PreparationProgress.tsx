import { useTranslation } from 'react-i18next';
import type { Preparation } from './model';
export function PreparationProgress({ value, failedToLoad, retry }: { value?: Preparation; failedToLoad: boolean; retry: () => void }) {
  const { t } = useTranslation();
  const labels = {
    queued: t('printSales.preparationQueued', 'Your prints are waiting to be prepared'),
    capturing: t('printSales.preparationCapturing', 'Saving the original photographs'),
    rendering: t('printSales.preparationRendering', 'Preparing your print files'),
    packaging: t('printSales.preparationPackaging', 'Building your print package'),
    ready: t('printSales.preparationReady', 'Your files are ready. Review your order to continue.'),
    failed: t('printSales.preparationFailed', 'We could not prepare these files. Return to your basket to try again, or contact the studio.'),
    expired: t('printSales.preparationExpired', 'This preparation has expired. Return to your basket to prepare a new order.'),
  };
  if (failedToLoad) return <div role="alert" className="space-y-2"><p>{t('printSales.preparationLoadFailed', 'We could not check preparation progress. Check again before confirming your order.')}</p>
    <button type="button" className="print-text-button" onClick={retry}>{t('printSales.checkProgress', 'Check progress again')}</button></div>;
  const label = value ? labels[value.stage] : t('printSales.preparationLoading', 'Checking your print preparation');
  const failed = value && ['failed', 'expired'].includes(value.stage);
  return <div className="space-y-2">
    <p role={failed ? 'alert' : 'status'}>{label}</p>
    {!failed && <progress className="print-preparation-progress" max={100} value={value?.percent} aria-label={t('printSales.preparationProgress', 'Print preparation progress')}
      aria-valuetext={value ? `${label} (${value.completed}/${value.total})` : label} />}
    {value && !failed && <p className="text-sm text-muted">{t('printSales.preparationFiles', { defaultValue: '{{completed}} of {{total}} files completed', completed: value.completed, total: value.total })}</p>}
  </div>;
}
