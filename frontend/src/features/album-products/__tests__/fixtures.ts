import type { Attribute, Offer, Option, Product } from '../model';

export const option = (id: string, name: string, extra: Partial<Option> = {}): Option => ({ id, name, active: true, imageId: null, ...extra });
const attribute = (id: string, name: string, options: Option[], extra: Partial<Attribute>): Attribute => ({
  id, name, groupId: `${id}-group`, optionIds: options.map((o) => o.id), required: true, multiple: false, addOn: false, dependsOn: [], options, ...extra,
});
const size = (id: string, name: string, height: number, width: number) => option(id, name, { width, height, unit: 'cm' });

export const attributes: Attribute[] = [
  attribute('material', 'Material', [option('cotton', 'Cotton'), option('silk', 'Silk'), option('leather', 'Leather')], { role: 'material' }),
  attribute('colour', 'Colour', [
    option('natural', 'Natural', { hex: '#d8cfc0' }), option('ivory', 'Ivory', { hex: '#f4ecd8' }), option('black', 'Black', { hex: '#1f1f1f' }),
  ], { role: 'colour', availableWhen: { attributeId: 'material', options: { natural: ['cotton'], ivory: ['silk'], black: ['leather', 'cotton'] } } }),
  attribute('format', 'Format', [option('landscape', 'Landscape'), option('square', 'Square')], { role: 'format' }),
  attribute('size', 'Size', [
    size('l2570', '25 × 70 cm', 25, 70), size('l3080', '30 × 80 cm', 30, 80), size('s2550', '25 × 50 cm', 25, 50), size('s3060', '30 × 60 cm', 30, 60),
  ], { role: 'size', spread: true, availableWhen: { attributeId: 'format', options: { l2570: ['landscape'], l3080: ['landscape'], s2550: ['square'], s3060: ['square'] } } }),
];
export const product = (id = 'album-a', name = 'Fine art album', extra: Partial<Product> = {}): Product => ({
  id, name, description: 'Layflat pages', active: true, version: 'a'.repeat(64), typeId: 'type', heroImageId: 'hero', attributes,
  guided: { clientFinal: true, photoRoles: [{ key: 'cover', min: 1, max: 1 }, { key: 'poster', min: 1, max: 2 }] },
  ...extra,
});
export const offer = (extra: Partial<Offer> = {}): Offer => ({
  id: 'offer-a', productId: 'album-a', enabled: true, revision: 1, status: 'draft', selection: null, product: product(), updatedAt: '', ...extra,
});
