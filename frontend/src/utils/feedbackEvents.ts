/**
 * Fired on window after the viewer took back all their likes at once (issue
 * 2561), with `{ slug }` as detail. Tiles holding a just-clicked like drop
 * that hold, so the cleared state from the refresh that follows shows
 * instead of the click.
 */
export const LIKES_CLEARED_EVENT = 'picpeak:likes-cleared';
