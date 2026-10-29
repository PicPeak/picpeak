import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthenticatedImage } from '../../components/common/AuthenticatedImage';
import type { Crop } from './model';
export function centredCrop(sourceRatio: number, targetRatio: number, zoom = 1): Crop {
  const width = Math.min(1, targetRatio / sourceRatio) / zoom,
    height = Math.min(1, sourceRatio / targetRatio) / zoom;
  return { x: (1 - width) / 2, y: (1 - height) / 2, width, height };
}
export function CropEditor({ src, slug, ratio, fit, value, onChange, resetOnLoad = true, background = '#ffffff' }: {
  src: string; slug: string; ratio: number; fit: 'cover' | 'contain'; value: Crop; onChange: (crop: Crop) => void; resetOnLoad?: boolean; background?: string;
}) {
  const { t } = useTranslation(), [sourceRatio, setSourceRatio] = useState(1), [zoom, setZoom] = useState(1);
  const drag = useRef<{ x: number; y: number; crop: Crop }>();
  const loaded = useCallback(({ width, height }: { width: number; height: number }) => {
    setSourceRatio(width / height); setZoom(1);
    if (resetOnLoad) onChange(fit === 'contain' ? { x: 0, y: 0, width: 1, height: 1 } : centredCrop(width / height, ratio));
  }, [fit, ratio, resetOnLoad, onChange]);
  return <div className="space-y-3 max-w-xl">
    <div className="relative overflow-hidden rounded-lg" style={{ aspectRatio: fit === 'contain' ? ratio : sourceRatio, background }}>
      <AuthenticatedImage key={src} src={src} slug={slug} isGallery alt={t('printSales.cropPreview', 'Selected photograph and print crop')}
        className="w-full h-full object-contain" onLoad={loaded} />
      {fit === 'cover' && <div role="img" aria-label={t('printSales.cropArea', 'Print crop; drag to reposition')}
        className="absolute border-2 border-white touch-none cursor-move"
        style={{ left: `${value.x * 100}%`, top: `${value.y * 100}%`, width: `${value.width * 100}%`, height: `${value.height * 100}%`, boxShadow: '0 0 0 100vmax rgb(0 0 0 / 45%)' }}
        onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, crop: value }; }}
        onPointerUp={() => { drag.current = undefined; }} onPointerCancel={() => { drag.current = undefined; }}
        onPointerMove={e => {
          if (!drag.current) return;
          const box = e.currentTarget.parentElement!.getBoundingClientRect(), start = drag.current;
          onChange({ ...value, x: Math.max(0, Math.min(1 - value.width, start.crop.x + (e.clientX - start.x) / box.width)),
            y: Math.max(0, Math.min(1 - value.height, start.crop.y + (e.clientY - start.y) / box.height)) });
        }} />}
    </div>
    {fit === 'cover' && <>
      <label className="block">{t('printSales.zoom', 'Crop zoom')}<input className="w-full" type="range" min={1} max={5} step={0.05} value={zoom}
        onChange={e => { setZoom(Number(e.target.value)); onChange(centredCrop(sourceRatio, ratio, Number(e.target.value))); }} /></label>
      {(['x', 'y'] as const).map(axis => <label key={axis} className="block">{axis === 'x' ? t('printSales.horizontalCrop', 'Horizontal position') : t('printSales.verticalCrop', 'Vertical position')}
        <input className="w-full" type="range" min={0} max={Math.max(0, 1 - value[axis === 'x' ? 'width' : 'height'])} step={0.001} value={value[axis]}
          onChange={e => onChange({ ...value, [axis]: Number(e.target.value) })} /></label>)}
      <button type="button" className="underline" onClick={() => { setZoom(1); onChange(centredCrop(sourceRatio, ratio)); }}>{t('printSales.resetCrop', 'Reset crop')}</button>
    </>}
  </div>;
}
export function CropPreview({ src, slug, crop, fit, ratio, background = '#ffffff' }: { src: string; slug: string; crop: Crop; fit: string; ratio: number; background?: string }) {
  const { t } = useTranslation();
  return <div className="relative w-24 overflow-hidden" style={{ aspectRatio: ratio, background }}>
    <AuthenticatedImage src={src} slug={slug} isGallery alt={t('printSales.preparedCrop', 'Selected print crop')}
      className={fit === 'contain' ? 'w-full h-full object-contain' : 'absolute max-w-none'}
      style={fit === 'contain' ? undefined : { width: `${100 / crop.width}%`, height: `${100 / crop.height}%`,
        left: `${-crop.x / crop.width * 100}%`, top: `${-crop.y / crop.height * 100}%` }} />
  </div>;
}
