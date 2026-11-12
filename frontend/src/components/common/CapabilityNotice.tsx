import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';

/**
 * Tells the visitor a ZIP download is paused for a moment, when the server
 * refuses one (config/api.ts raises the event). Upload screens show their own
 * message for the same refusal, so a toast here would say it twice. The toast
 * id stops repeated refusals from stacking.
 */
export const CapabilityNotice: React.FC = () => {
  const { t } = useTranslation();

  useEffect(() => {
    const show = (event: Event) => {
      if ((event as CustomEvent<unknown>).detail !== 'downloads.archive') return;
      toast.info(t('capabilityNotice.archive'), { toastId: 'capability-archive' });
    };
    window.addEventListener('picpeak:capability-unavailable', show);
    return () => window.removeEventListener('picpeak:capability-unavailable', show);
  }, [t]);

  return null;
};
