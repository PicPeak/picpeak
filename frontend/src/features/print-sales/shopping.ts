import { photoDisplayFilename } from '../../utils/photoFilename';
import type { Photo } from '../../types';
import type { CartItem, Crop, Variant } from './model';
export const MAX_ITEMS = 20;
export const whole: Crop = { x: 0, y: 0, width: 1, height: 1 };
export type BasketLine = CartItem & { lineId: string; version?: string };
export type Draft = CartItem & { ready: boolean; version?: string };
export const isPhotograph = (p: Photo) => p.media_type !== 'video' && !p.mime_type?.startsWith('video/');
export const photoName = photoDisplayFilename;
// Both renditions preserve the full image ratio; never derive crop geometry from a square tile.
export const photoSource = (p: Photo) => p.preview_url || p.slideshow_url || p.url;
export const validQuantity = (n: number) => Number.isSafeInteger(n) && n >= 1 && n <= 100;
export function validCrop(c: Crop): boolean {
  return !!c && [c.x, c.y, c.width, c.height].every(Number.isFinite) && c.x >= 0 && c.y >= 0 &&
    c.width > 0 && c.height > 0 && c.x + c.width <= 1.000001 && c.y + c.height <= 1.000001;
}
export function readBasket(value: string | null): BasketLine[] {
  try {
    const parsed: unknown = JSON.parse(value || '[]');
    if (!Array.isArray(parsed)) return [];
    const ids = new Set<string>();
    return parsed.filter((i): i is BasketLine => !!i && Number.isSafeInteger(i.photoId) && i.photoId > 0 &&
      typeof i.profileId === 'string' && i.profileId.length > 0 && i.profileId.length <= 200 && validQuantity(i.quantity) &&
      ['cover', 'contain'].includes(i.fit) && validCrop(i.crop)).slice(0, MAX_ITEMS).map(i => {
      const lineId = typeof i.lineId === 'string' && i.lineId.length < 100 && !ids.has(i.lineId) ? i.lineId : crypto.randomUUID();
      ids.add(lineId);
      return { lineId, ...requestItem(i), ...(typeof i.version === 'string' && i.version.length <= 200 ? { version: i.version } : {}) };
    });
  } catch { return []; }
}
export function requestItem(i: CartItem): CartItem {
  return { photoId: i.photoId, profileId: i.profileId, quantity: i.quantity, fit: i.fit,
    crop: i.fit === 'contain' ? { ...whole } : { x: i.crop.x, y: i.crop.y, width: i.crop.width, height: i.crop.height } };
}
export function newDraft(photoId: number, variant: Variant, previous?: Draft): Draft {
  return { photoId, profileId: variant.id, quantity: previous?.quantity || 1,
    fit: previous && variant.fitModes.includes(previous.fit) ? previous.fit : variant.fitModes.includes('cover') ? 'cover' : variant.fitModes[0],
    crop: { ...whole }, ready: false, version: variant.version };
}
export function dimensions(v: Variant) {
  return v.trimMm ? `${v.trimMm.width / 10} × ${v.trimMm.height / 10} cm` :
    v.selection.attributes?.flatMap(a => a.options.filter(o => o.width && o.height).map(o => o.name)).join(' · ') ||
    `${v.artwork.widthMm} × ${v.artwork.heightMm} mm artwork`;
}
export const choices = (v: Variant, omitSizes = false) => v.selection.attributes?.flatMap(a => {
  const options = a.options.filter(o => !omitSizes || !(o.width && o.height));
  return options.length ? [`${a.name}: ${options.map(o => o.name).join(', ')}`] : [];
}).join(' · ') || '';
