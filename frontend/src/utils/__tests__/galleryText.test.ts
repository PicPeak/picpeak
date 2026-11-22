/**
 * Multilingual gallery texts (issue 2550): which text a field shows per mode.
 */
import { describe, expect, it } from 'vitest';
import type { PhotoCategory } from '../../types';
import {
  baseLanguage,
  galleryTextConfig,
  galleryTextLanguages,
  resolveCategories,
  resolvePair,
  resolveText,
} from '../galleryText';

const config = (mode: string, language: string, primary: string | null = 'de', secondary: string | null = 'en') =>
  galleryTextConfig({ text_language_mode: mode as never, text_primary_language: primary, text_secondary_language: secondary }, language);

const title = { en: 'Wedding', fr: 'Mariage' };

describe('galleryTextConfig', () => {
  it('reads an unknown or missing mode as off', () => {
    expect(config('auto', 'en').mode).toBe('off');
    expect(galleryTextConfig(undefined, 'en')).toEqual({ mode: 'off', primary: null, secondary: null, language: 'en' });
  });

  it('keeps the base language of a regional tag', () => {
    expect(baseLanguage('de-AT')).toBe('de');
    expect(baseLanguage('pt_BR')).toBe('pt');
    expect(config('visitor', 'fr-CH').language).toBe('fr');
  });
});

describe('resolveText', () => {
  it('off: always the default text, whatever is translated', () => {
    expect(resolveText(config('off', 'en'), 'Hochzeit', title)).toBe('Hochzeit');
  });

  it('visitor: the visitor language first', () => {
    expect(resolveText(config('visitor', 'en'), 'Hochzeit', title)).toBe('Wedding');
    expect(resolveText(config('visitor', 'fr-FR'), 'Hochzeit', title)).toBe('Mariage');
  });

  it('visitor: then the primary language, then the default text', () => {
    expect(resolveText(config('visitor', 'es'), 'Hochzeit', { de: 'Die Hochzeit', en: 'Wedding' })).toBe('Die Hochzeit');
    expect(resolveText(config('visitor', 'es'), 'Hochzeit', title)).toBe('Hochzeit');
    expect(resolveText(config('visitor', 'es', null), 'Hochzeit', title)).toBe('Hochzeit');
    expect(resolveText(config('visitor', 'en'), 'Hochzeit', undefined)).toBe('Hochzeit');
  });

  it('visitor: a blank translation does not count', () => {
    expect(resolveText(config('visitor', 'en'), 'Hochzeit', { en: '  ' })).toBe('Hochzeit');
  });

  it('bilingual: the primary language for single-language places, whatever the visitor reads', () => {
    expect(resolveText(config('bilingual', 'en'), 'Hochzeit', title)).toBe('Hochzeit');
    expect(resolveText(config('bilingual', 'en', 'en', 'de'), 'Hochzeit', title)).toBe('Wedding');
  });

  it('keeps an empty default empty', () => {
    expect(resolveText(config('visitor', 'es'), null, title)).toBeNull();
  });
});

describe('resolvePair', () => {
  it('bilingual: primary prominent, secondary below', () => {
    expect(resolvePair(config('bilingual', 'fr'), 'Hochzeit', title)).toEqual({ primary: 'Hochzeit', secondary: 'Wedding' });
  });

  it('bilingual: no second line without its text, or when it says the same', () => {
    expect(resolvePair(config('bilingual', 'en'), 'Hochzeit', {})).toEqual({ primary: 'Hochzeit', secondary: null });
    expect(resolvePair(config('bilingual', 'en'), 'Party', { en: 'Party' })).toEqual({ primary: 'Party', secondary: null });
    expect(resolvePair(config('bilingual', 'en', 'de', 'de'), 'Hochzeit', title).secondary).toBeNull();
  });

  it('visitor and off: never a second line', () => {
    expect(resolvePair(config('visitor', 'en'), 'Hochzeit', title)).toEqual({ primary: 'Wedding', secondary: null });
    expect(resolvePair(config('off', 'en'), 'Hochzeit', title)).toEqual({ primary: 'Hochzeit', secondary: null });
  });
});

describe('resolveCategories', () => {
  const categories: PhotoCategory[] = [
    {
      id: 1, name: 'Trauung', slug: 'trauung', is_global: false,
      translations: { name: { en: 'Ceremony' } },
      chapter: {
        heading: null, subheading: 'Treffen mit den Ja-Sagern', time: '12:00', location: 'Standesamt',
        translations: { subheading: { en: 'Meeting the yes-sayers' }, location: { en: 'Registry office' } },
      },
    },
    { id: 2, name: 'Feier', slug: 'feier', is_global: true },
  ];

  it('off: hands the categories back untouched', () => {
    expect(resolveCategories(config('off', 'en'), categories)).toBe(categories);
  });

  it('visitor: names and chapter texts in the visitor language, the time as it is', () => {
    const [first, second] = resolveCategories(config('visitor', 'en'), categories)!;
    expect(first.name).toBe('Ceremony');
    expect(first.chapter).toMatchObject({ heading: null, subheading: 'Meeting the yes-sayers', time: '12:00', location: 'Registry office' });
    expect(first.chapter?.secondary).toBeUndefined();
    expect(second.name).toBe('Feier');
  });

  it('bilingual: the name in the primary language only; the marker in both', () => {
    const [first] = resolveCategories(config('bilingual', 'en'), categories)!;
    expect(first.name).toBe('Trauung');
    expect(first.chapter).toMatchObject({ subheading: 'Treffen mit den Ja-Sagern', location: 'Standesamt' });
    // The heading falls back to the name, so its second line is the name's.
    expect(first.chapter?.secondary).toEqual({ heading: 'Ceremony', subheading: 'Meeting the yes-sayers' });
  });

  it('bilingual: a blank default heading keeps an explicit second-language heading', () => {
    const blank = [{ ...categories[0], chapter: { ...categories[0].chapter!, heading: null, translations: { heading: { en: 'Wedding ceremony' } } } }];
    expect(resolveCategories(config('bilingual', 'en'), blank)![0].chapter?.secondary?.heading).toBe('Wedding ceremony');
    // Without one, the name's second language; without that, nothing.
    const noName = [{ ...categories[0], translations: {}, chapter: { ...categories[0].chapter!, heading: null, translations: {} } }];
    expect(resolveCategories(config('bilingual', 'en'), noName)![0].chapter?.secondary).toBeUndefined();
  });

  it('bilingual: a written heading takes its own second line', () => {
    const withHeading = [{ ...categories[0], chapter: { ...categories[0].chapter!, heading: 'Ja', translations: { heading: { en: 'Yes' } } } }];
    expect(resolveCategories(config('bilingual', 'en'), withHeading)![0].chapter?.secondary).toEqual({ heading: 'Yes', subheading: null });
  });
});

describe('galleryTextLanguages', () => {
  it('collects the primary language and every language a text is written in', () => {
    const langs = galleryTextLanguages(config('visitor', 'en'), { translations: { event_name: { en: 'Wedding' } } },
      [{ id: 1, name: 'x', slug: 'x', is_global: false, translations: { name: { fr: 'Cérémonie' } } }]);
    expect(langs.sort()).toEqual(['de', 'en', 'fr']);
  });

  it('is a single language when nothing is translated, and empty while off', () => {
    expect(galleryTextLanguages(config('visitor', 'en'), { translations: {} }, [])).toEqual(['de']);
    expect(galleryTextLanguages(config('off', 'en'), { translations: { event_name: { en: 'x' } } }, [])).toEqual([]);
  });

  it('bilingual: both chosen languages', () => {
    expect(galleryTextLanguages(config('bilingual', 'en'), undefined, undefined).sort()).toEqual(['de', 'en']);
  });
});
