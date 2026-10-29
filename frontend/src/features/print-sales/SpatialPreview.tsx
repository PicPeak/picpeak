import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Crop, Variant } from './model';
import { CropPreview } from './CropEditor';

// Fixed scene dimensions in millimetres: changing product size never rescales the room.
export const spaces = { desk: { width: 1200, height: 850 }, wall: { width: 3000, height: 2250 } };
export function SpatialPreview({ variant, src, slug, crop, fit }: { variant: Variant; src: string; slug: string; crop: Crop; fit: string }) {
  const { t } = useTranslation(), trim = variant.trimMm;
  const [shown, setShown] = useState(false), [scene, setScene] = useState<'desk' | 'wall'>(() => trim && Math.max(trim.width, trim.height) <= 300 ? 'desk' : 'wall');
  const trimWidth = trim?.width, trimHeight = trim?.height;
  useEffect(() => {
    if (trimWidth && trimHeight && (trimWidth > spaces.desk.width * .85 || trimHeight > spaces.desk.height * .65)) setScene('wall');
  }, [trimWidth, trimHeight]);
  if (!trim) return null; // Older servers do not distinguish artwork from the finished trim size.
  const space = spaces[scene], fits = trim.width <= space.width * .85 && trim.height <= space.height * (scene === 'desk' ? .65 : .6);
  const bleed = variant.bleedMm || { left: 0, top: 0, right: 0, bottom: 0 };
  return <section className="print-space-section">
    <button type="button" className="print-text-button" aria-expanded={shown} onClick={() => setShown(!shown)}>{shown ? t('printSales.hideSpace', 'Hide scale preview') : t('printSales.showSpace', 'See it in a space')}</button>
    {shown && <div className="space-y-3 mt-3">
      <div className="print-segment" aria-label={t('printSales.scene', 'Preview scene')}>
        <button type="button" aria-pressed={scene === 'desk'} onClick={() => setScene('desk')}>{t('printSales.desk', 'On a desk')}</button>
        <button type="button" aria-pressed={scene === 'wall'} onClick={() => setScene('wall')}>{t('printSales.wall', 'On a wall')}</button>
      </div>
      <div className={`print-space print-space-${scene}`} style={{ aspectRatio: space.width / space.height }} aria-label={scene === 'desk' ? t('printSales.deskScale', 'Desk preview: 120 cm wide') : t('printSales.wallScale', 'Wall preview: 300 cm wide')}>
        <div className="print-space-furniture" aria-hidden="true"><i /><i /><i /></div>
        {fits && <div data-testid="spatial-print" className="print-space-art" style={{ width: `${trim.width / space.width * 100}%`, height: `${trim.height / space.height * 100}%` }}>
          <div className="absolute" style={{ width: `${variant.artwork.widthMm / trim.width * 100}%`, height: `${variant.artwork.heightMm / trim.height * 100}%`, left: `${-bleed.left / trim.width * 100}%`, top: `${-bleed.top / trim.height * 100}%` }}>
            <CropPreview src={src} slug={slug} crop={crop} fit={fit} background={variant.background} ratio={variant.artwork.widthMm / variant.artwork.heightMm} className="w-full h-full" />
          </div>
        </div>}
      </div>
      {!fits && <p role="status" className="text-sm">{t('printSales.spaceTooSmall', 'This print does not fit this scene at the illustrated scale. Try the wall view or a smaller size.')}</p>}
      <p className="text-xs text-muted">{t('printSales.sceneWidth', 'Scene width')}: {space.width / 10} cm</p>
      <p className="text-xs text-muted">{trim.width / 10} × {trim.height / 10} cm · {t('printSales.scaleNote', 'Illustrative scale; accessories are not included. Colours and trim may vary. This preview does not change your crop.')}</p>
    </div>}
  </section>;
}
