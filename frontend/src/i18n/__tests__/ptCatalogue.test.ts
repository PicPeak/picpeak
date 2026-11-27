import { describe, expect, it } from 'vitest';
import en from '../locales/en.json';
import pt from '../locales/pt.json';

type Catalog = { [key: string]: string | string[] | Catalog };

const flatten = (node: Catalog, prefix = '', out: Record<string, unknown> = {}) => {
  for (const [key, value] of Object.entries(node)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value as Catalog, `${prefix}${key}.`, out);
    else out[`${prefix}${key}`] = value;
  }
  return out;
};

const PLURAL = /_(zero|one|two|few|many|other)$/;

// {{name}} interpolations and <0>/<strong> Trans tags. A plural form may leave
// {{count}} implicit ("Select this photo"), so it is not compared there.
const tokens = (key: string, value: unknown) => {
  if (typeof value !== 'string') return [];
  const found = [
    ...[...value.matchAll(/\{\{\s*([^},\s]+)[^}]*\}\}/g)].map((m) => `{{${m[1]}}}`),
    ...[...value.matchAll(/<\/?(\w+)\s*\/?>/g)].map((m) => `<${m[1]}>`),
  ];
  return (PLURAL.test(key) ? found.filter((t) => t !== '{{count}}') : found).sort();
};

// A Portuguese value with a different placeholder shows a raw {{name}} or drops
// the value it should carry (issue 2617 brought pt to full coverage).
describe('pt catalogue', () => {
  const enFlat = flatten(en as Catalog);
  const ptFlat = flatten(pt as Catalog);

  it('keeps the placeholders of the English source in every translated value', () => {
    const mismatched = Object.keys(ptFlat)
      .filter((key) => key in enFlat)
      .filter((key) => tokens(key, enFlat[key]).join() !== tokens(key, ptFlat[key]).join());
    expect(mismatched).toEqual([]);
  });

  it('has no empty translations', () => {
    const empty = Object.entries(ptFlat).filter(([, value]) => typeof value === 'string' && !value.trim());
    expect(empty).toEqual([]);
  });
});
