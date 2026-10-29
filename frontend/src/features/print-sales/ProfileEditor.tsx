import { useTranslation } from 'react-i18next';
import { ConfigurationPicker } from '../album-products/ConfigurationPicker';
import { Input, Switch } from '../../components/common';
import type { Product } from '../album-products/model';
import type { Profile, Settings, Output, ColourSpace } from './model';
import { ProductionStartingPoints } from './ProductionStartingPoints';
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
    <ProductionStartingPoints value={m} onChange={manufacturing => definition({ manufacturing, enabled: false })} />
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
    <Input label={t('printSales.supplierName', 'Supplier label (optional)')} maxLength={120} value={d.supplierName || ''}
      onChange={e => definition({ supplierName: e.target.value })} />
    <label className="block">{t('printSales.supplierInstructions', 'Supplier preparation and ordering instructions')}
      <textarea className="input w-full" rows={3} maxLength={2000} value={d.instructions || ''} onChange={e => definition({ instructions: e.target.value })} /></label>
    <fieldset className="space-y-3"><legend>{t('printSales.outputRequirements', 'Production output requirements')}</legend>
      <label className="block">{t('printSales.outputFormat', 'File format')}
        <select className="input" value={m.output.format} onChange={e => {
          const format = e.target.value as Output['format'];
          const colourSpace = m.output.colourSpace;
          const output: Output = format === 'jpeg' ? { format, colourSpace, quality: 95, chromaSubsampling: '4:4:4' }
            : format === 'png' ? { format, colourSpace, compressionLevel: 6 } : { format, colourSpace, compression: 'lzw' };
          definition({ manufacturing: { ...m, output } });
        }}><option value="jpeg">JPEG</option><option value="png">PNG</option><option value="tiff">TIFF (8-bit)</option></select></label>
      {m.output.format === 'jpeg' && <>
        <Input label={t('printSales.jpegQuality', 'JPEG quality (1–100)')} type="number" min={1} max={100} value={m.output.quality ?? 95}
          onChange={e => definition({ manufacturing: { ...m, output: { ...m.output, format: 'jpeg', quality: Number(e.target.value) } } })} />
        <label className="block">{t('printSales.jpegSampling', 'JPEG chroma sampling')}
          <select className="input" value={m.output.chromaSubsampling ?? '4:4:4'} onChange={e => definition({ manufacturing: { ...m, output: { ...m.output, format: 'jpeg', chromaSubsampling: e.target.value as '4:4:4' | '4:2:0' } } })}>
            <option value="4:4:4">4:4:4</option><option value="4:2:0">4:2:0</option></select></label>
      </>}
      {m.output.format === 'png' && <Input label={t('printSales.pngCompression', 'PNG compression (0–9)')} type="number" min={0} max={9} value={m.output.compressionLevel ?? 6}
        onChange={e => definition({ manufacturing: { ...m, output: { ...m.output, format: 'png', compressionLevel: Number(e.target.value) } } })} />}
      {m.output.format === 'tiff' && <label className="block">{t('printSales.tiffCompression', 'TIFF compression')}
        <select className="input" value={m.output.compression ?? 'lzw'} onChange={e => definition({ manufacturing: { ...m, output: { ...m.output, format: 'tiff', compression: e.target.value as 'lzw' | 'deflate' | 'none' } } })}>
          <option value="lzw">LZW</option><option value="deflate">Deflate</option><option value="none">{t('printSales.noCompression', 'Uncompressed')}</option></select></label>}
      <label className="block">{t('printSales.background', 'Background and fit border colour')}
        <input type="color" value={m.background ?? '#ffffff'} onChange={e => definition({ manufacturing: { ...m, background: e.target.value } })} /></label>
      <label className="block">{t('printSales.outputColourProfile', 'Output colour profile')}
        <select className="input w-full" value={m.output.colourSpace} onChange={e => definition({ enabled: false,
          manufacturing: { ...m, output: { ...m.output, colourSpace: e.target.value as ColourSpace } } })}>
          <option value="srgb">sRGB</option><option value="adobe-rgb-1998">Adobe RGB (1998) compatible</option>
          <option value="display-p3">Display P3</option><option value="prophoto-rgb">ProPhoto RGB (ROMM RGB)</option>
        </select></label>
      <p className="text-sm text-muted">{t('printSales.supportedColour', 'Select the RGB profile your supplier accepts. Output is converted and tagged with that profile. Printer/paper soft-proof profiles are different; do not substitute one as the output profile.')}</p>
      {m.output.colourSpace !== 'srgb' && <p className="text-sm text-muted">{t('printSales.wideGamutHelp', 'Preparation can reduce the original colour gamut. A wider output profile cannot restore lost colours. Verify colour with your supplier’s test prints before enabling.')}</p>}
      {m.output.colourSpace === 'adobe-rgb-1998' && <p className="text-sm text-muted">{t('printSales.adobeCompatibleHelp', 'Uses an open Adobe RGB (1998) compatible ICC profile. Confirm acceptance if your supplier requires Adobe’s exact profile name or file.')}</p>}
      {m.output.colourSpace === 'prophoto-rgb' && <p className="text-sm text-warning-text">{t('printSales.proPhotoHelp', 'This exporter delivers 8 bits per channel. Use ProPhoto only where the supplier explicitly accepts 8-bit ProPhoto files; 16-bit editing and export are separate requirements.')}</p>}
    </fieldset>
    <fieldset><legend>{t('printSales.allowedFit', 'Photo placement choices offered to buyers')}</legend>
      {(['cover', 'contain'] as const).map(mode => <label key={mode} className="flex gap-2">
        <input type="checkbox" checked={m.fitModes.includes(mode)} onChange={e => definition({ manufacturing: { ...m,
          fitModes: e.target.checked ? [...m.fitModes, mode] : m.fitModes.filter(f => f !== mode) } })} />
        {mode === 'cover' ? t('printSales.cover', 'Crop to fill') : t('printSales.fitWhole', 'Fit whole photograph')}</label>)}
    </fieldset>
    <p className="text-sm text-muted">{t('printSales.rectangularOutput', 'Single rectangular face. Display sizes are separate from production measurements. Verify your supplier requirements before enabling.')}</p>
    <Switch label={t('printSales.enableProfile', 'Enable this verified print variant')} checked={d.enabled} onChange={enabled => definition({ enabled })} />
  </article>;
}
