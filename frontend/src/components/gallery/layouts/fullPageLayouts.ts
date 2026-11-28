/**
 * The layouts that draw their own page: hero or cover, nav, footer. The
 * gallery shell (header, sidebar, toolbar) steps aside for them and hands
 * them the feature toolbox through `beforeGrid` instead.
 */
export const FULL_PAGE_LAYOUTS = ['gallery-premium', 'gallery-story', 'gallery-folio'] as const;

export const isFullPageLayout = (layout: string | null | undefined): boolean =>
  (FULL_PAGE_LAYOUTS as readonly string[]).includes(layout ?? '');

/**
 * Premium (yet-another-react-lightbox) and Story mount a lightbox of their
 * own. Folio opens the shared PhotoLightbox that PhotoGridWithLayouts mounts
 * for the standard layouts.
 */
export const layoutOwnsLightbox = (layout: string | null | undefined): boolean =>
  layout === 'gallery-premium' || layout === 'gallery-story';
