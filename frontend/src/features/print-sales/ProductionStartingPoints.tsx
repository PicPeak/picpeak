import { useTranslation } from 'react-i18next';
import { Button } from '../../components/common';
import { PrintSizePicker } from '../album-products/PrintSizePicker';
import { millimetres } from '../album-products/printSizes';
import type { Profile } from './model';
type Manufacturing = Profile['definition']['manufacturing'];
export function ProductionStartingPoints({ value, onChange }: { value: Manufacturing; onChange: (value: Manufacturing) => void }) {
  const { t } = useTranslation();
  const edges = (group: 'bleedMm' | 'safeInsetMm', amount: number) => onChange({ ...value,
    [group]: { top: amount, right: amount, bottom: amount, left: amount } });
  return <fieldset className="border border-line rounded-lg p-3 space-y-3">
    <legend>{t('printSales.genericStartingPoints', 'Generic production starting points')}</legend>
    <p className="text-sm text-muted">{t('printSales.startingPointHelp', 'Copy a starting value, then verify your supplier’s actual template. Applying a starting point disables the variant until you enable it again after review. Prices and catalogue choices stay as configured.')}</p>
    <PrintSizePicker onChange={size => onChange({ ...value, trimMm: millimetres(size) })} />
    <Button variant="secondary" onClick={() => onChange({ ...value, trimMm: { width: value.trimMm.height, height: value.trimMm.width } })}>
      {t('printSales.swapOrientation', 'Swap width and height')}</Button>
    <div className="grid gap-3 sm:grid-cols-2">
      <label>{t('printSales.bleedStartingPoint', 'Added bleed on every edge')}
        <select className="input w-full" value="" onChange={e => { if (e.target.value !== '') edges('bleedMm', Number(e.target.value)); }}>
          <option value="">{t('printSales.keepEdges', 'Keep current edge values')}</option>
          <option value="0">{t('printSales.noAddedBleed', 'No added bleed (0 mm)')}</option>
          <option value="2">2 mm</option><option value="3">3 mm</option><option value="3.175">⅛ in (3.175 mm)</option><option value="5">5 mm</option>
        </select></label>
      <label>{t('printSales.safeStartingPoint', 'Safe inset inside every trim edge')}
        <select className="input w-full" value="" onChange={e => { if (e.target.value !== '') edges('safeInsetMm', Number(e.target.value)); }}>
          <option value="">{t('printSales.keepEdges', 'Keep current edge values')}</option>
          <option value="0">0 mm</option><option value="3">3 mm</option><option value="5">5 mm</option><option value="6.35">¼ in (6.35 mm)</option>
        </select></label>
    </div>
    <p className="text-sm text-muted">{t('printSales.trimGuidance', 'Bleed extends artwork beyond the finished trim; safe insets are guides for keeping important content inside it, not printed borders. Photographic edge cropping varies by supplier. Do not add press bleed or crop marks unless the product requires them. A 10 × 15 cm print is not exactly 4 × 6 in.')}</p>
  </fieldset>;
}
