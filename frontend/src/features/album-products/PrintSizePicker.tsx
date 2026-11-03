import { useTranslation } from 'react-i18next';
import { printSizes, type PrintSize } from './printSizes';
export function PrintSizePicker({ onChange }: { onChange: (size: PrintSize) => void }) {
  const { t } = useTranslation();
  return <label className="block">{t('printSales.sizeStartingPoint', 'Start from a common size')}
    <select className="input w-full" value="" onChange={e => {
      const size = printSizes.find(s => s.id === e.target.value); if (size) onChange({ ...size });
    }}><option value="">{t('printSales.chooseSizeStartingPoint', 'Choose a size to copy into the editable dimensions')}</option>
      {(['metric', 'imperial', 'square', 'paper'] as const).map(group => <optgroup key={group}
        label={t(`printSales.sizeGroup.${group}`, { metric: 'Metric photographic sizes', imperial: 'Inch photographic sizes', square: 'Square sizes', paper: 'ISO A paper sizes' }[group])}>
        {printSizes.filter(s => s.group === group).map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
      </optgroup>)}
    </select>
  </label>;
}
