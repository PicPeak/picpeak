import type { TFunction } from 'i18next';
import type { Attribute, LibraryGroup, Option, ProductType } from './model';

const id = () => crypto.randomUUID();
const option = (name: string, extra: Partial<Option> = {}): Option => ({
  id: id(),
  name,
  active: true,
  imageId: null,
  ...extra,
});
const attribute = (group: LibraryGroup, extra: Partial<Attribute>): Attribute => ({
  id: id(),
  name: group.name,
  groupId: group.id,
  optionIds: group.options.map((o) => o.id),
  options: [],
  required: true,
  multiple: false,
  addOn: false,
  dependsOn: [],
  ...extra,
});

/**
 * Example data for a guided album, put into the unsaved catalogue for the
 * studio to edit: three materials with their colours, two formats with their
 * sizes. Sizes are the open album, height × width, so 25 × 70 cm opens to a
 * spread 70 cm wide and two 35 × 25 cm pages. Nothing in the app depends on
 * these values.
 */
export function albumStarter(t: TFunction): { library: LibraryGroup[]; type: ProductType } {
  const cm = (name: string, height: number, width: number) =>
    option(name, { width, height, unit: 'cm' });
  const cotton = option(t('products.starter.cotton', 'Cotton'));
  const silk = option(t('products.starter.silk', 'Silk'));
  const leather = option(t('products.starter.leather', 'Leather'));
  const colours: [Option, Option][] = [
    [option(t('products.starter.natural', 'Natural'), { hex: '#d8cfc0' }), cotton],
    [option(t('products.starter.slate', 'Slate'), { hex: '#5b6670' }), cotton],
    [option(t('products.starter.ivory', 'Ivory'), { hex: '#f4ecd8' }), silk],
    [option(t('products.starter.champagne', 'Champagne'), { hex: '#d9c49a' }), silk],
    [option(t('products.starter.black', 'Black'), { hex: '#1f1f1f' }), leather],
    [option(t('products.starter.cognac', 'Cognac'), { hex: '#8a4b24' }), leather],
  ];
  const landscape = option(t('products.starter.landscape', 'Landscape'));
  const square = option(t('products.starter.square', 'Square'));
  const sizes: [Option, Option][] = [
    [cm('25 × 70 cm', 25, 70), landscape],
    [cm('30 × 80 cm', 30, 80), landscape],
    [cm('25 × 50 cm', 25, 50), square],
    [cm('30 × 60 cm', 30, 60), square],
  ];
  const library: LibraryGroup[] = [
    { id: id(), name: t('products.starter.materials', 'Album material'), kind: 'choice', options: [cotton, silk, leather] },
    { id: id(), name: t('products.starter.colours', 'Album colour'), kind: 'colour', options: colours.map(([o]) => o) },
    { id: id(), name: t('products.starter.formats', 'Album format'), kind: 'choice', options: [landscape, square] },
    { id: id(), name: t('products.starter.sizes', 'Album size'), kind: 'size', options: sizes.map(([o]) => o) },
  ];
  const material = attribute(library[0], { role: 'material' });
  const format = attribute(library[2], { role: 'format' });
  const rule = (attributeId: string, pairs: [Option, Option][]) => ({
    attributeId,
    options: Object.fromEntries(pairs.map(([o, parent]) => [o.id, [parent.id]])),
  });
  return {
    library,
    type: {
      id: id(),
      name: t('products.starter.type', 'Album'),
      active: true,
      attributes: [
        material,
        attribute(library[1], { role: 'colour', availableWhen: rule(material.id, colours) }),
        format,
        attribute(library[3], { role: 'size', spread: true, availableWhen: rule(format.id, sizes) }),
      ],
    },
  };
}
