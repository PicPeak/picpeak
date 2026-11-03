import { useTranslation } from 'react-i18next';
import { Button, Input } from '../../components/common';
import type { DeliveryZone, Settings } from './model';
export function DeliveryEditor({ value, onChange }: { value: Settings; onChange: (value: Settings) => void }) {
  const { t } = useTranslation(), zones = value.shippingZones || [];
  const update = (shippingZones: DeliveryZone[]) => onChange({ ...value, shippingZones, shippingPresetId: null,
    countries: [...new Set(shippingZones.flatMap(z => z.countries).filter(Boolean))].sort() });
  const priceOptions = <><option value="">{t('printSales.includedDelivery', 'Delivery included (no extra line)')}</option>
    {value.presets?.filter(p => !p.product_id).map(p => <option key={p.id} value={p.id}>{p.name} ({p.currency})</option>)}</>;
  return <section className="space-y-4">
    <label className="block">{t('printSales.deliveryMethod', 'Delivery pricing')}
      <select className="input w-full" value={zones.length ? 'zones' : 'single'} onChange={e => {
        if (e.target.value === 'single') onChange({ ...value, shippingZones: [], shippingPresetId: null });
        else update([{ id: crypto.randomUUID(), name: '', countries: value.countries, cataloguePresetId: value.shippingPresetId }]);
      }}><option value="single">{t('printSales.singleDelivery', 'One delivery price for all enabled countries')}</option>
        <option value="zones">{t('printSales.zoneDelivery', 'Delivery zones with separate prices')}</option></select>
    </label>
    {!zones.length ? <>
      <label className="block">{t('printSales.countries', 'Delivery countries (two-letter codes, separated by commas)')}
        <input className="input w-full" value={value.countries.join(', ')} onChange={e => onChange({ ...value, countries: e.target.value.toUpperCase().split(',').map(s => s.trim()) })} /></label>
      <label className="block">{t('printSales.deliveryPrice', 'Delivery price from CRM catalogue')}
        <select className="input w-full" value={value.shippingPresetId ?? ''} onChange={e => onChange({ ...value, shippingPresetId: e.target.value ? Number(e.target.value) : null })}>{priceOptions}</select></label>
    </> : <>
      <p className="text-sm text-muted">{t('printSales.zoneHelp', 'Each country belongs to one zone. Only countries assigned to a zone are offered for delivery. Prices use ordinary CRM catalogue items.')}</p>
      {zones.map((zone, n) => <fieldset className="border border-line rounded-lg p-4 space-y-3" key={zone.id}>
        <legend>{t('printSales.deliveryZone', 'Delivery zone')} {n + 1}</legend>
        <Input label={t('printSales.zoneName', 'Zone name')} maxLength={100} value={zone.name}
          onChange={e => update(zones.map((z, i) => i === n ? { ...z, name: e.target.value } : z))} />
        <label className="block">{t('printSales.countries', 'Delivery countries (two-letter codes, separated by commas)')}
          <input className="input w-full" value={zone.countries.join(', ')} onChange={e => update(zones.map((z, i) => i === n ? { ...z, countries: e.target.value.toUpperCase().split(',').map(s => s.trim()) } : z))} /></label>
        <label className="block">{t('printSales.deliveryPrice', 'Delivery price from CRM catalogue')}
          <select className="input w-full" value={zone.cataloguePresetId ?? ''} onChange={e => update(zones.map((z, i) => i === n ? { ...z, cataloguePresetId: e.target.value ? Number(e.target.value) : null } : z))}>{priceOptions}</select></label>
        <Button variant="ghost" onClick={() => update(zones.filter((_, i) => i !== n))}>{t('printSales.removeZone', 'Remove delivery zone')}</Button>
      </fieldset>)}
      <Button variant="secondary" disabled={zones.length >= 30} onClick={() => update([...zones, { id: crypto.randomUUID(), name: '', countries: [], cataloguePresetId: null }])}>{t('printSales.addZone', 'Add delivery zone')}</Button>
    </>}
  </section>;
}
