import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthenticatedImage } from '../../components/common/AuthenticatedImage';
import type { Crop, Edges } from './model';
import { whole } from './shopping';
export function centredCrop(sourceRatio: number, targetRatio: number, zoom = 1): Crop {
  const width = Math.min(1, targetRatio / sourceRatio) / zoom,
    height = Math.min(1, sourceRatio / targetRatio) / zoom;
  return { x: (1 - width) / 2, y: (1 - height) / 2, width, height };
}
export function CropEditor({ src, slug, ratio, fit, value, onChange, resetOnLoad = true, background = '#ffffff', onReady, bleed, artwork }: {
  src: string; slug: string; ratio: number; fit: 'cover' | 'contain'; value: Crop; onChange: (crop: Crop) => void;
  resetOnLoad?: boolean; background?: string; bleed?: Edges; artwork?: { widthMm: number; heightMm: number }; onReady?: (ready: boolean) => void;
}) {
  const { t } = useTranslation(), [sourceRatio, setSourceRatio] = useState(1), [ready, setReady] = useState(false);
  const identity = `${src}:${ratio}:${fit}`, initialized = useRef('');
  const latest = useRef({ onChange, onReady, resetOnLoad, value }); latest.current = { onChange, onReady, resetOnLoad, value };
  const drag = useRef<{ id: number; x: number; y: number; crop: Crop }>();
  useEffect(() => { setReady(false); latest.current.onReady?.(false); drag.current = undefined; }, [identity]);
  const loaded = useCallback(({ width, height }: { width: number; height: number }) => {
    if (!(width > 0 && height > 0)) return;
    setSourceRatio(width / height);
    if (initialized.current !== identity) {
      initialized.current = identity;
      if (latest.current.resetOnLoad) latest.current.onChange(fit === 'contain' ? { ...whole } : centredCrop(width / height, ratio));
    }
    setReady(true); latest.current.onReady?.(true);
  }, [identity, fit, ratio]);
  const move = (x: number, y: number) => onChange({ ...value, x: Math.max(0, Math.min(1 - value.width, x)), y: Math.max(0, Math.min(1 - value.height, y)) });
  const base = centredCrop(sourceRatio, ratio), zoom = Math.max(1, base.width / value.width);
  const hasBleed = bleed && Object.values(bleed).some(n => n > 0);
  return <div className="space-y-3">
    <div className="print-crop-stage">
      <div role="group" aria-label={t('printSales.cropArea', 'Print crop; drag photograph to reposition')} tabIndex={fit === 'cover' && ready ? 0 : undefined}
        className={`print-crop-frame ${fit === 'cover' ? 'touch-none cursor-move' : ''}`} style={{ aspectRatio: ratio, background, '--print-ratio': ratio } as React.CSSProperties}
        onKeyDown={e => {
          if (fit !== 'cover' || !ready) return;
          const step = e.shiftKey ? .05 : .01;
          if (e.key === 'Home') { e.preventDefault(); onChange(centredCrop(sourceRatio, ratio)); }
          else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
            e.preventDefault(); move(value.x + (e.key === 'ArrowLeft' ? step : e.key === 'ArrowRight' ? -step : 0), value.y + (e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0));
          }
        }}
        onPointerDown={e => {
          if (fit !== 'cover' || !ready || (e.pointerType === 'mouse' && e.button !== 0)) return;
          e.currentTarget.setPointerCapture(e.pointerId); drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, crop: value };
        }}
        onPointerUp={() => { drag.current = undefined; }} onPointerCancel={() => { drag.current = undefined; }} onLostPointerCapture={() => { drag.current = undefined; }}
        onPointerMove={e => {
          const start = drag.current, box = e.currentTarget.getBoundingClientRect();
          if (!start || start.id !== e.pointerId || !box.width || !box.height) return;
          move(start.crop.x - (e.clientX - start.x) / box.width * start.crop.width, start.crop.y - (e.clientY - start.y) / box.height * start.crop.height);
        }}>
        <AuthenticatedImage key={identity} src={src} slug={slug} isGallery draggable={false}
          alt={t('printSales.cropPreview', 'Selected photograph and print crop')} onLoad={loaded}
          onUnavailable={unavailable => { if (unavailable) { setReady(false); latest.current.onReady?.(false); } }}
          className={fit === 'contain' ? 'w-full h-full object-contain pointer-events-none' : 'absolute max-w-none pointer-events-none'}
          style={fit === 'contain' ? undefined : { width: `${100 / value.width}%`, height: `${100 / value.height}%`, left: `${-value.x / value.width * 100}%`, top: `${-value.y / value.height * 100}%` }} />
        {hasBleed && artwork && <div className="print-trim-guide" aria-hidden="true" style={{ left: `${bleed.left / artwork.widthMm * 100}%`, right: `${bleed.right / artwork.widthMm * 100}%`, top: `${bleed.top / artwork.heightMm * 100}%`, bottom: `${bleed.bottom / artwork.heightMm * 100}%` }} />}
      </div>
    </div>
    {hasBleed && artwork && <p className="text-xs text-muted">{t('printSales.trimHint', 'The dashed line marks the finished edge. The area outside it is trimmed off; keep important details inside.')}</p>}
    <p className="text-sm text-muted">{fit === 'cover' ? t('printSales.dragHint', 'Drag the photograph to adjust the crop. Arrow keys also move it; Home centres it.') : t('printSales.containHint', 'The whole photograph is included. Empty space uses the studio’s configured background.')}</p>
    {fit === 'cover' && <fieldset disabled={!ready} className="space-y-2">
      <label className="block text-sm">{t('printSales.zoom', 'Crop zoom')}<input className="w-full" type="range" min={1} max={Math.max(5, zoom)} step={0.05} value={zoom}
        onChange={e => {
          const next = centredCrop(sourceRatio, ratio, Number(e.target.value));
          onChange({ ...next, x: Math.max(0, Math.min(1 - next.width, value.x + (value.width - next.width) / 2)), y: Math.max(0, Math.min(1 - next.height, value.y + (value.height - next.height) / 2)) });
        }} /></label>
      <details><summary className="text-sm cursor-pointer">{t('printSales.finePosition', 'Fine-tune position')}</summary>
        {(['x', 'y'] as const).map(axis => <label key={axis} className="block text-sm">{axis === 'x' ? t('printSales.horizontalCrop', 'Horizontal position') : t('printSales.verticalCrop', 'Vertical position')}
          <input className="w-full" type="range" min={0} max={Math.max(0, 1 - value[axis === 'x' ? 'width' : 'height'])} step={0.001} value={value[axis]}
            onChange={e => onChange({ ...value, [axis]: Number(e.target.value) })} /></label>)}
      </details>
      <button type="button" className="underline text-sm" onClick={() => onChange(centredCrop(sourceRatio, ratio))}>{t('printSales.resetCrop', 'Reset crop')}</button>
    </fieldset>}
  </div>;
}
export function CropPreview({ src, slug, crop, fit, ratio, background = '#ffffff', className = 'w-24' }: {
  src: string; slug: string; crop: Crop; fit: string; ratio: number; background?: string; className?: string;
}) {
  const { t } = useTranslation();
  return <div className={`relative overflow-hidden shrink-0 ${className}`} style={{ aspectRatio: ratio, background, '--print-ratio': ratio } as React.CSSProperties}>
    <AuthenticatedImage src={src} slug={slug} isGallery alt={t('printSales.preparedCrop', 'Selected print crop')}
      className={fit === 'contain' ? 'w-full h-full object-contain' : 'absolute max-w-none'}
      style={fit === 'contain' ? undefined : { width: `${100 / crop.width}%`, height: `${100 / crop.height}%`, left: `${-crop.x / crop.width * 100}%`, top: `${-crop.y / crop.height * 100}%` }} />
  </div>;
}
