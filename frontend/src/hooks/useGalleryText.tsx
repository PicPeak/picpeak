/**
 * Multilingual gallery texts (issue 2550) in React: the resolution of
 * utils/galleryText for the visitor's current UI language, and a context
 * that hands the title's and welcome message's secondary line to whichever
 * header or layout draws them.
 */
import React, { createContext, useContext, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TextTranslations } from '../types';
import {
  galleryTextConfig,
  resolvePair,
  resolveText,
  type GalleryTextConfig,
  type GalleryTextSource,
} from '../utils/galleryText';

export interface GalleryTextApi {
  config: GalleryTextConfig;
  /** The one text a field shows (chips, tiles, sidebar, location). */
  text: (defaultText: string | null | undefined, translations?: TextTranslations) => string | null;
  /** Primary and, in bilingual mode, secondary text (title, welcome message, chapter heading). */
  pair: (defaultText: string | null | undefined, translations?: TextTranslations) => { primary: string | null; secondary: string | null };
}

/** The gallery's text resolution, following the visitor's UI language. */
export function useGalleryText(source: GalleryTextSource | null | undefined): GalleryTextApi {
  const { i18n } = useTranslation();
  const language = i18n?.resolvedLanguage || i18n?.language || 'en';
  const mode = source?.text_language_mode;
  const primary = source?.text_primary_language;
  const secondary = source?.text_secondary_language;
  return useMemo(() => {
    const config = galleryTextConfig({ text_language_mode: mode, text_primary_language: primary, text_secondary_language: secondary }, language);
    return {
      config,
      text: (defaultText, translations) => resolveText(config, defaultText, translations),
      pair: (defaultText, translations) => resolvePair(config, defaultText, translations),
    };
  }, [mode, primary, secondary, language]);
}

export interface GallerySecondaryTexts {
  title: string | null;
  welcome: string | null;
}

const GallerySecondaryTextContext = createContext<GallerySecondaryTexts>({ title: null, welcome: null });

export const GallerySecondaryTextProvider = GallerySecondaryTextContext.Provider;

export const useGallerySecondaryText = (): GallerySecondaryTexts => useContext(GallerySecondaryTextContext);

/**
 * The bilingual mode's second language below the title or the welcome
 * message, smaller and quieter. Renders nothing outside bilingual mode.
 * Inherits the colour of the text it sits under, so it follows the theme.
 */
export const GallerySecondaryText: React.FC<{
  kind: keyof GallerySecondaryTexts;
  /** On the same line after a slash, for one-line headers. */
  inline?: boolean;
  className?: string;
}> = ({ kind, inline = false, className = '' }) => {
  const text = useGallerySecondaryText()[kind];
  if (!text) return null;
  if (inline) {
    return (
      <span className={`gallery-text-secondary font-normal opacity-75 ${className}`} data-gallery-text="secondary">
        {' / '}{text}
      </span>
    );
  }
  const size = kind === 'title' ? 'text-[0.55em] mt-1 font-normal' : 'text-[0.92em] mt-1';
  return (
    <span className={`gallery-text-secondary block opacity-75 ${size} ${className}`} data-gallery-text="secondary">
      {text}
    </span>
  );
};
