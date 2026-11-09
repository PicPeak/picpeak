/**
 * The Masonry mode a gallery renders (issue 2444). Every mode has its own
 * layout pass, and a value none of them knows used to fall through to the
 * columns render with no columns filled: an empty gallery with no error.
 * 'justified' is the picker's "Google Photos" option, the same justified rows
 * as 'rows'. Anything else unknown (an edited theme, a value a newer release
 * wrote) renders as columns, the default.
 */
export type MasonryMode = 'columns' | 'rows' | 'flickr' | 'quilted';

const MODES: readonly MasonryMode[] = ['columns', 'rows', 'flickr', 'quilted'];

export function masonryModeOf(stored: unknown): MasonryMode {
  if (stored === 'justified') return 'rows';
  return MODES.includes(stored as MasonryMode) ? (stored as MasonryMode) : 'columns';
}
