/**
 * The steps of the first-visit walkthrough (issue 2551).
 *
 * Only features this gallery offers to this visitor get a step, so a gallery
 * with downloads off has no download step. The client link adds the step
 * about hiding photos from guests; a customer-portal session gets the client
 * tour without it (it cannot hide photos).
 *
 * Shown in this order:
 *   browse → favorites → download → faces → upload → hide → help
 *
 * At most MAX_WALKTHROUGH_STEPS. When more would apply, the ones kept are
 * picked by PRIORITY (what a visitor most often asks the photographer
 * about first) and then shown in the order above:
 *   browse, download, favorites, hide, faces, upload, help
 */

export type WalkthroughScope = 'client' | 'customer' | 'guest';

export type WalkthroughStepId = 'browse' | 'favorites' | 'download' | 'faces' | 'upload' | 'hide' | 'help';

export interface WalkthroughFeatures {
  scope: WalkthroughScope;
  /** The gallery shows category chips or chapter markers. */
  hasCategories: boolean;
  likes: boolean;
  favorites: boolean;
  downloads: boolean;
  /** "People in this gallery" is on. */
  people: boolean;
  /** Selfie search is on (implies people). */
  selfie: boolean;
  uploads: boolean;
}

export interface WalkthroughStep {
  id: WalkthroughStepId;
  /** i18n keys below `gallery.walkthrough.steps.<id>`. */
  titleKey: string;
  bodyKey: string;
  /**
   * Selectors of the real controls this step points at, best first. The
   * first one on screen wins; none on screen gives a centered card.
   */
  anchors: string[];
}

export const MAX_WALKTHROUGH_STEPS = 5;

/**
 * The like and favourite actions a gallery layout offers its visitors
 * (checked per layout for issue 2551):
 *
 *  - grid, masonry, mosaic, timeline, carousel: a heart on the tile (likes),
 *    and the shared PhotoLightbox with heart and bookmark (favourites)
 *  - Story: a heart on its cards, and the shared PhotoLightbox
 *  - Premium: a heart on its tiles and in its nav; its own lightbox
 *    (yet-another-react-lightbox) has no favourite, and nothing else does
 *
 * So likes are on a photo everywhere, favourites only by opening a photo,
 * and not at all in Premium. The step's wording follows the same split.
 */
export function layoutFeedbackActions(layout: string | undefined): { likes: boolean; favorites: boolean } {
  return { likes: true, favorites: layout !== 'gallery-premium' };
}

const DISPLAY_ORDER: WalkthroughStepId[] = ['browse', 'favorites', 'download', 'faces', 'upload', 'hide', 'help'];
const PRIORITY: WalkthroughStepId[] = ['browse', 'download', 'favorites', 'hide', 'faces', 'upload', 'help'];

const tour = (name: string) => `[data-tour="${name}"]`;

export function buildWalkthroughSteps(features: WalkthroughFeatures): WalkthroughStep[] {
  const base = 'gallery.walkthrough.steps';
  const candidates = new Map<WalkthroughStepId, WalkthroughStep>();

  candidates.set('browse', {
    id: 'browse',
    titleKey: `${base}.browse.title`,
    bodyKey: features.hasCategories ? `${base}.browse.bodyCategories` : `${base}.browse.body`,
    anchors: features.hasCategories ? [tour('categories')] : [],
  });

  if (features.likes || features.favorites) {
    const variant = features.likes && features.favorites ? 'bodyBoth' : features.likes ? 'bodyLikes' : 'bodyFavorites';
    candidates.set('favorites', {
      id: 'favorites',
      titleKey: `${base}.favorites.title`,
      bodyKey: `${base}.favorites.${variant}`,
      anchors: [tour('photo')],
    });
  }

  if (features.downloads) {
    candidates.set('download', {
      id: 'download',
      titleKey: `${base}.download.title`,
      bodyKey: `${base}.download.body`,
      anchors: [tour('download-all'), tour('photo')],
    });
  }

  if (features.people) {
    candidates.set('faces', {
      id: 'faces',
      titleKey: `${base}.faces.title`,
      bodyKey: features.selfie ? `${base}.faces.bodySelfie` : `${base}.faces.body`,
      anchors: [tour('people')],
    });
  }

  if (features.uploads) {
    candidates.set('upload', {
      id: 'upload',
      titleKey: `${base}.upload.title`,
      bodyKey: `${base}.upload.body`,
      anchors: [tour('upload')],
    });
  }

  if (features.scope === 'client') {
    candidates.set('hide', {
      id: 'hide',
      titleKey: `${base}.hide.title`,
      bodyKey: `${base}.hide.body`,
      anchors: [tour('hide-photo'), tour('client-banner')],
    });
  }

  candidates.set('help', {
    id: 'help',
    titleKey: `${base}.help.title`,
    bodyKey: `${base}.help.body`,
    anchors: [tour('walkthrough-help')],
  });

  const kept = new Set(PRIORITY.filter((id) => candidates.has(id)).slice(0, MAX_WALKTHROUGH_STEPS));
  return DISPLAY_ORDER.filter((id) => kept.has(id)).map((id) => candidates.get(id)!);
}
