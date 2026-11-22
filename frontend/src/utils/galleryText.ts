/**
 * Multilingual gallery texts (issue 2550): which text a gallery field shows.
 *
 * The stored column (event_name, welcome_message, category name, chapter
 * texts) is the default text; `translations` holds the hand-written texts in
 * other languages, language code → text. By the gallery's mode:
 *
 *   off        the default text, as before
 *   visitor    the visitor's UI language → the primary language → the default
 *   bilingual  the primary language (else the default) prominent, and for the
 *              title, the welcome message and the chapter heading/subheading
 *              the secondary language smaller below; every other text shows
 *              the primary language alone
 */
import type { ChapterMarkerText, PhotoCategory, TextLanguageMode, TextTranslations } from '../types';

export interface GalleryTextConfig {
  mode: TextLanguageMode;
  primary: string | null;
  secondary: string | null;
  /** The visitor's UI language, e.g. 'de' or 'de-AT'. */
  language: string;
}

export interface GalleryTextSource {
  text_language_mode?: TextLanguageMode | string | null;
  text_primary_language?: string | null;
  text_secondary_language?: string | null;
}

/** A text pair: `secondary` only in bilingual mode, and only when it says something else. */
export interface TextPair {
  primary: string;
  secondary: string | null;
}

const MODES: TextLanguageMode[] = ['off', 'visitor', 'bilingual'];

/** 'de-AT' → 'de'. */
export const baseLanguage = (language: string | null | undefined): string =>
  (language || '').toLowerCase().split(/[-_]/)[0];

export function galleryTextConfig(source: GalleryTextSource | null | undefined, language: string): GalleryTextConfig {
  const mode = MODES.includes(source?.text_language_mode as TextLanguageMode)
    ? source?.text_language_mode as TextLanguageMode
    : 'off';
  return {
    mode,
    primary: source?.text_primary_language || null,
    secondary: source?.text_secondary_language || null,
    language: baseLanguage(language),
  };
}

const textIn = (translations: TextTranslations | undefined, language: string | null): string | null => {
  if (!translations || !language) return null;
  const text = translations[language];
  return typeof text === 'string' && text.trim() !== '' ? text : null;
};

/** The one text a field shows. */
export function resolveText(config: GalleryTextConfig, defaultText: string, translations?: TextTranslations): string;
export function resolveText(config: GalleryTextConfig, defaultText: string | null | undefined, translations?: TextTranslations): string | null;
export function resolveText(config: GalleryTextConfig, defaultText: string | null | undefined, translations?: TextTranslations): string | null {
  if (config.mode === 'off') return defaultText ?? null;
  if (config.mode === 'visitor') {
    const visitor = textIn(translations, config.language);
    if (visitor) return visitor;
  }
  return textIn(translations, config.primary) ?? defaultText ?? null;
}

/** The primary text and, in bilingual mode, the secondary one below it. */
export function resolvePair(config: GalleryTextConfig, defaultText: string, translations?: TextTranslations): TextPair;
export function resolvePair(config: GalleryTextConfig, defaultText: string | null | undefined, translations?: TextTranslations): { primary: string | null; secondary: string | null };
export function resolvePair(config: GalleryTextConfig, defaultText: string | null | undefined, translations?: TextTranslations) {
  const primary = resolveText(config, defaultText, translations);
  if (config.mode !== 'bilingual' || !config.secondary || config.secondary === config.primary) {
    return { primary, secondary: null };
  }
  const secondary = textIn(translations, config.secondary);
  return { primary, secondary: secondary && secondary !== primary ? secondary : null };
}

/**
 * Categories with their texts resolved for this visitor: `name` (and the
 * chapter's heading, subheading and location) become the text to show, and
 * in bilingual mode the chapter carries its secondary heading and
 * subheading. A heading that falls back to the category name takes the
 * name's secondary text, so the marker still reads in both languages.
 */
export function resolveCategories<T extends PhotoCategory>(config: GalleryTextConfig, categories: T[] | undefined): T[] | undefined {
  if (!categories || config.mode === 'off') return categories;
  return categories.map((category) => {
    const name = resolvePair(config, category.name, category.translations?.name);
    const chapter = category.chapter ? resolveChapter(config, category.chapter, name) : undefined;
    return { ...category, name: name.primary, ...(chapter ? { chapter } : {}) };
  });
}

function resolveChapter(config: GalleryTextConfig, chapter: ChapterMarkerText, name: { secondary: string | null }): ChapterMarkerText {
  const t = chapter.translations || {};
  const heading = resolvePair(config, chapter.heading, t.heading);
  const subheading = resolvePair(config, chapter.subheading, t.subheading);
  const secondaryHeading = chapter.heading || textIn(t.heading, config.primary) ? heading.secondary : name.secondary;
  return {
    ...chapter,
    heading: heading.primary,
    subheading: subheading.primary,
    location: resolveText(config, chapter.location, t.location),
    ...(secondaryHeading || subheading.secondary
      ? { secondary: { heading: secondaryHeading, subheading: subheading.secondary } }
      : {}),
  };
}

/**
 * The languages this gallery has texts in: the primary one (its default
 * text) and every language any translation is written in. The language
 * switcher shows only when there is more than one.
 */
export function galleryTextLanguages(
  config: GalleryTextConfig,
  event: { translations?: Record<string, TextTranslations | undefined> } | null | undefined,
  categories: PhotoCategory[] | undefined,
): string[] {
  if (config.mode === 'off') return [];
  const found = new Set<string>();
  if (config.primary) found.add(config.primary);
  if (config.mode === 'bilingual' && config.secondary) found.add(config.secondary);
  const add = (map: TextTranslations | undefined) => {
    Object.entries(map || {}).forEach(([language, text]) => { if (typeof text === 'string' && text.trim()) found.add(language); });
  };
  Object.values(event?.translations || {}).forEach(add);
  (categories || []).forEach((category) => {
    add(category.translations?.name);
    Object.values(category.chapter?.translations || {}).forEach(add);
  });
  return [...found];
}
