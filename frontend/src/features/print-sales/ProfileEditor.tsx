import { useTranslation } from 'react-i18next';
import { ConfigurationPicker } from '../album-products/ConfigurationPicker';
import { Input, Switch } from '../../components/common';
import type { Product } from '../album-products/model';
import type { Profile, Settings } from './model';
export function ProfileEditor({ value, products, presets, onChange }: {
  value: Profile; products: Product[]; presets: Settings['presets']; onChange: (value: Profile) => void;
}) {
  const { t } = useTranslation(), d = value.definition, m = d.manufacturing;
  const product = products.find(p => p.id === d.selection.productId);
  const definition = (patch: Partial<Profile['definition']>) => onChange({ ...value, definition: { ...d, ...patch } });
  return <article className="rounded-lg border border-line p-4 space-y-4">
    <label className="block">{t('printSales.product', 'Catalogue product')}
      <select className="input w-full" value={d.selection.productId} onChange={e => {
        const p = products.find(p => p.id === e.target.value);
        if (p) onChange({ cataloguePresetId: 0, definition: { ...d, enabled: false,
          selection: { productId: p.id, productVersion: p.version!, values: {} } } });
      }}><option value="">{t('printSales.chooseProduct', 'Choose a product')}</option>
        {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
    </label>
    {product && <ConfigurationPicker product={product} values={d.selection.values}
      onChange={values => definition({ selection: { productId: product.id, productVersion: product.version!, values } })} />}
    {product && d.selection.productVersion !== product.version && <p className="text-warning-text">
      {t('printSales.staleProfile', 'The catalogue changed. Review the options and production measurements before enabling this profile.')}
      <button type="button" className="underline ml-2" onClick={() => definition({ enabled: false,
        selection: { ...d.selection, productVersion: product.version! } })}>{t('printSales.rebind', 'Use current catalogue version')}</button>
    </p>}
    <label className="block">{t('printSales.priceItem', 'CRM price item')}
      <select className="input w-full" value={value.cataloguePresetId} onChange={e => onChange({ ...value, cataloguePresetId: Number(e.target.value) })}>
        <option value={0}>{t('printSales.choosePrice', 'Choose a price item')}</option>
        {presets?.filter(p => p.product_id === d.selection.productId).map(p => <option key={p.id} value={p.id}>{p.name} ({p.currency})</option>)}
      </select></label>
    <div className="grid gap-4 sm:grid-cols-2">
      {(['width', 'height'] as const).map(axis => <Input key={axis} type="number" min={1} max={2000} step="any"
        label={axis === 'width' ? t('printSales.trimWidth', 'Trim width (mm)') : t('printSales.trimHeight', 'Trim height (mm)')}
        value={m.trimMm[axis]} onChange={e => definition({ manufacturing: { ...m, trimMm: { ...m.trimMm, [axis]: Number(e.target.value) } } })} />)}
    </div>
    {(['bleedMm', 'safeInsetMm'] as const).map(group => <fieldset key={group}>
      <legend>{group === 'bleedMm' ? t('printSales.bleed', 'Bleed outside trim (mm)') : t('printSales.safeInset', 'Safe area inside trim (mm)')}</legend>
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">{(['top', 'right', 'bottom', 'left'] as const).map(side =>
        <Input key={side} type="number" min={0} max={100} step="any" label={t(`printSales.edge.${side}`, side)} value={m[group][side]}
          onChange={e => definition({ manufacturing: { ...m, [group]: { ...m[group], [side]: Number(e.target.value) } } })} />)}</div>
    </fieldset>)}
    <div className="grid gap-3 sm:grid-cols-2">{(['targetDpi', 'minimumDpi'] as const).map(key =>
      <Input key={key} type="number" min={72} max={600} label={key === 'targetDpi' ? t('printSales.targetDpi', 'Output resolution (DPI)') : t('printSales.minimumDpi', 'Minimum source resolution (DPI)')}
        value={m.resolution[key]} onChange={e => definition({ manufacturing: { ...m, resolution: { ...m.resolution, [key]: Number(e.target.value) } } })} />)}</div>
    <Input label={t('printSales.labReference', 'Lab reference or production code')} maxLength={200} value={d.labReference}
      onChange={e => definition({ labReference: e.target.value })} />
    <p className="text-sm text-muted">{t('printSales.rectangularOnly', 'Single rectangular face, sRGB JPEG. Display sizes are separate from production measurements. Verify the lab requirements before enabling.')}</p>
    <Switch label={t('printSales.enableProfile', 'Enable this verified print variant')} checked={d.enabled} onChange={enabled => definition({ enabled })} />
  </article>;
}
