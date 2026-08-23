import { KEYBIND_SCHEMES, type ColorLabel, type KeybindMode } from '../services/feedback.service';

/**
 * Lightbox keyboard shortcuts for proofing (#1044).
 *
 * Shared by the gallery lightbox and the admin photo viewer — two components
 * with independent key handlers that would otherwise drift the moment either
 * one gained a shortcut.
 */

export type FeedbackKeyAction =
  | { type: 'color'; color: ColorLabel }
  | { type: 'rating'; value: number }
  | { type: 'clear' };

interface ResolveOptions {
  mode: KeybindMode;
  allowColorLabels: boolean;
  allowRatings: boolean;
}

/**
 * True when the event came from somewhere a digit is real input — a search
 * box, a comment field, a contenteditable. Without this, typing "2024" into
 * the filename search would relabel the open photo.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || typeof element.tagName !== 'string') return false;
  const tag = element.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return element.isContentEditable === true;
}

/**
 * Map a keydown to a proofing action, or null when the key isn't bound in the
 * active scheme (the caller's other shortcuts then get their turn).
 *
 * Modified keys are never bound: Ctrl+1 / Cmd+1 switch browser tabs, and Alt
 * combinations are OS shortcuts.
 */
export function resolveFeedbackKey(
  event: KeyboardEvent,
  { mode, allowColorLabels, allowRatings }: ResolveOptions
): FeedbackKeyAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (isTypingTarget(event.target)) return null;

  const scheme = KEYBIND_SCHEMES[mode] || KEYBIND_SCHEMES.colors;
  const key = event.key;

  if (allowColorLabels) {
    const color = scheme.colors[key];
    if (color) return { type: 'color', color };
  }

  if (allowRatings) {
    const rating = scheme.ratings[key];
    if (rating !== undefined) return { type: 'rating', value: rating };
  }

  // '0' clears whichever value the scheme is primarily about: the star rating
  // in Lightroom mode (matching Lightroom itself), the colour label in
  // colour-only mode, where there are no stars to clear.
  if (key === '0') {
    if (mode === 'lightroom' && allowRatings) return { type: 'rating', value: 0 };
    if (allowColorLabels) return { type: 'clear' };
    if (allowRatings) return { type: 'rating', value: 0 };
  }

  return null;
}

/**
 * Which key sets which colour in the active scheme, for the hints rendered on
 * the swatches — e.g. { green: '1', yellow: '2', red: '3' }.
 */
export function colorShortcutHints(mode: KeybindMode): Partial<Record<ColorLabel, string>> {
  const scheme = KEYBIND_SCHEMES[mode] || KEYBIND_SCHEMES.colors;
  const hints: Partial<Record<ColorLabel, string>> = {};
  for (const [key, color] of Object.entries(scheme.colors)) {
    hints[color] = key;
  }
  return hints;
}
