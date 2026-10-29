import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api } from '../../config/api';
import { Switch } from '../../components/common';
import { useFeatureEnabled } from '../../contexts/FeatureFlagsContext';
import { usePermissions } from '../../contexts/PermissionsContext';
import { errorMessage } from '../album-products/model';
export function PrintGallerySettings({ eventId, ownsEvent }: { eventId: number; ownsEvent: boolean }) {
  const enabled = useFeatureEnabled('printSales'), { hasPermission } = usePermissions(), { t } = useTranslation();
  const [on, setOn] = useState(false), [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    if (ownsEvent && enabled) api.get<{ enabled: boolean }>(`/admin/print-sales/events/${eventId}`).then(r => {
      if (active) { setOn(r.data.enabled); setLoaded(true); }
    }).catch(e => { if (active) setError(errorMessage(e)); });
    return () => { active = false; };
  }, [eventId, ownsEvent, enabled]);
  if (!enabled || !ownsEvent || !hasPermission('bills.manage') || !hasPermission('customers.edit')) return null;
  return <section className="p-4 border border-line rounded-lg space-y-3">
    <Switch label={t('printSales.enableGallery', 'Enable print ordering for assigned customer accounts')} checked={on} disabled={!loaded || busy}
      onChange={async next => {
        setBusy(true); setError('');
        try { await api.put(`/admin/print-sales/events/${eventId}`, { enabled: next }); setOn(next); }
        catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
      }} />
    <Link className="underline" to="/admin/settings?tab=printSales">{t('printSales.manage', 'Configure print variants and review orders')}</Link>
    {error && <p role="alert" className="text-danger-text">{error}</p>}
  </section>;
}
