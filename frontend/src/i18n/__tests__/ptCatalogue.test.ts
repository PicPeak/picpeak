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

  // pt is Brazilian Portuguese. These are words and constructions European
  // Portuguese uses where Brazilian does not ("ficheiro" for arquivo, "está a
  // enviar" for "está enviando"); a new value containing one was most likely
  // written for pt-PT. Deliberately small: only markers with no Brazilian use.
  const EUROPEAN_PORTUGUESE = [
    /ficheir/i, /\belimin/i, /descarreg/i, /\bregist(?!r)/i, /utilizador/i, /\becrã/i, /telemóve/i,
    /\bdefinições/i, /palavras?-passe/i, /\bpartilh/i, /\bequipas?\b/i, /\bcontact/i, /secç/i,
    /marcas? de água/i, /bases? de dados/i, /\bbrowser\b/i, /multimédia/i, /logótipo/i, /\bdemasiad/i, /ámos\b/i,
    /\best(á|ão|ava|amos|ou) a \w+[aei]r\b/i,
  ];

  it('uses Brazilian, not European, Portuguese', () => {
    const european = Object.entries(ptFlat)
      .filter(([, value]) => typeof value === 'string' && EUROPEAN_PORTUGUESE.some((marker) => marker.test(value)))
      .map(([key]) => key);
    expect(european).toEqual([]);
  });

  // Portuguese has a "many" plural category (exact millions). en has none, so
  // nothing reminds anyone to update it; it must read like "other".
  it('keeps every _many plural form identical to its _other form', () => {
    const drifted = Object.keys(ptFlat)
      .filter((key) => key.endsWith('_many'))
      .filter((key) => ptFlat[key] !== ptFlat[`${key.slice(0, -'_many'.length)}_other`]);
    expect(drifted).toEqual([]);
  });

  it('has no empty translations', () => {
    const empty = Object.entries(ptFlat).filter(([, value]) => typeof value === 'string' && !value.trim());
    expect(empty).toEqual([]);
  });
});
