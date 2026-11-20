import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthenticatedImage } from '../../../common';
import type { ChapterMarkerText, Photo, PhotoCategory } from '../../../../types';

/**
 * The anchor a link such as `#chapter-12-ceremony` jumps to (issue 2548).
 * The id keeps it unique: a global and an event category can share a slug.
 */
export const chapterAnchorId = (category: Pick<PhotoCategory, 'id' | 'slug'>): string =>
  `chapter-${category.id}${category.slug ? `-${category.slug}` : ''}`;

/**
 * A stored 'HH:MM' time of day in the viewer's locale ("12:00" / "12:00 PM").
 * A fixed calendar day keeps it a wall-clock time, never shifted by a zone.
 */
export function formatChapterTime(time: string | null | undefined, locale: string): string | null {
  const match = time ? /^(\d{2}):(\d{2})$/.exec(time) : null;
  if (!match) return null;
  try {
    return new Date(2000, 0, 1, Number(match[1]), Number(match[2]))
      .toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  } catch {
    return time as string;
  }
}

interface StoryChapterMarkerProps {
  category: Pick<PhotoCategory, 'id' | 'slug' | 'name'>;
  chapter: ChapterMarkerText;
  /** 'hero' shows the category's hero photo behind the text; without one it falls back to the divider. */
  variant: 'divider' | 'hero';
  heroPhoto?: Photo | null;
  slug: string;
}

/**
 * A chapter marker (issue 2548): heading, then "time · location", then the
 * subheading. Every value is rendered as a text node, never as HTML.
 */
export const StoryChapterMarker: React.FC<StoryChapterMarkerProps> = ({
  category,
  chapter,
  variant,
  heroPhoto,
  slug,
}) => {
  const { i18n } = useTranslation();
  const anchor = chapterAnchorId(category);
  const heading = chapter.heading || category.name;
  const time = formatChapterTime(chapter.time, i18n.language);
  const heroSrc = heroPhoto ? heroPhoto.hero_url || heroPhoto.url || heroPhoto.thumbnail_url : null;
  const showHero = variant === 'hero' && !!heroSrc;

  // The gallery loads after the page, so the browser's own jump to a
  // `#chapter-…` hash has nothing to land on yet: do it once mounted.
  useEffect(() => {
    if (typeof window === 'undefined' || window.location.hash !== `#${anchor}`) return;
    document.getElementById(anchor)?.scrollIntoView?.();
  }, [anchor]);

  return (
    <header
      className={`story-chapter ${showHero ? 'story-chapter-hero' : 'story-chapter-divider'}`}
      data-chapter-style={showHero ? 'hero' : 'divider'}
    >
      {showHero && (
        <div className="story-chapter-bg" aria-hidden="true">
          <AuthenticatedImage
            src={heroSrc as string}
            alt=""
            className="w-full h-full object-cover"
            isGallery={true}
            slug={slug}
          />
          <div className="story-chapter-scrim" />
        </div>
      )}
      <div className="story-chapter-text">
        <h2 id={anchor} className="story-chapter-heading">{heading}</h2>
        {(time || chapter.location) && (
          <p className="story-chapter-meta">
            {time && <time dateTime={chapter.time as string}>{time}</time>}
            {time && chapter.location && ' · '}
            {chapter.location && <span>{chapter.location}</span>}
          </p>
        )}
        {chapter.subheading && <p className="story-chapter-subheading">{chapter.subheading}</p>}
      </div>
    </header>
  );
};
