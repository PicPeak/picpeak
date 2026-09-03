/**
 * Which input the visitor is using RIGHT NOW — not what the device is (#1275).
 *
 * `matchMedia('(hover: none) and (pointer: coarse)')` answers a different
 * question: it describes the device's PRIMARY pointer. On anything with both
 * — a touchscreen laptop, an iPad with a trackpad, a Surface — one of the two
 * inputs is then handled as if it were the other:
 *
 *   - fine-primary + finger: the tap is treated as a click, so a photo opens
 *     with no tap-to-reveal and the tile's own actions need a hover that a
 *     finger cannot produce.
 *   - coarse-primary + mouse: the click is treated as a tap, so opening a
 *     photo takes two clicks and hovering does nothing.
 *
 * Pointer events carry the answer per interaction. One window-level listener
 * pair feeds a module-level mode that every subscriber shares, so all cards
 * agree and the listener count does not scale with the number of tiles.
 *
 * `pointermove` matters as much as `pointerdown`: a mouse announces itself by
 * approaching, and the mode has to be right BEFORE the click lands, not as a
 * consequence of it.
 */
import { useSyncExternalStore } from 'react';

export type InputMode = 'touch' | 'mouse';

const COARSE_POINTER_QUERY = '(hover: none) and (pointer: coarse)';

/**
 * The reading to start from, before anything has been touched or moved.
 * The primary-pointer query is the best guess available at that moment, and it
 * is right for the two single-input cases that make up most traffic — a phone
 * and a desktop. On a hybrid it is a coin toss that the first real interaction
 * corrects.
 */
function initialMode(): InputMode {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    // No matchMedia (old embedded webviews, some test environments). A
    // touchscreen signal is the only thing left to go on.
    const hasNavigator = typeof navigator !== 'undefined';
    const touchish = (typeof window !== 'undefined' && 'ontouchstart' in window)
      || (hasNavigator && navigator.maxTouchPoints > 0);
    return touchish ? 'touch' : 'mouse';
  }
  return window.matchMedia(COARSE_POINTER_QUERY).matches ? 'touch' : 'mouse';
}

let mode: InputMode = initialMode();
const subscribers = new Set<() => void>();

function setMode(next: InputMode) {
  if (next === mode) return;
  mode = next;
  subscribers.forEach((notify) => notify());
}

function handlePointer(event: PointerEvent) {
  // A pen is grouped with touch: it taps rather than hovers on most hardware,
  // and being wrong in that direction only costs a reveal step, where being
  // wrong the other way puts an action under a pointer that cannot see it.
  if (event.pointerType === 'touch' || event.pointerType === 'pen') setMode('touch');
  else if (event.pointerType === 'mouse') setMode('mouse');
  // Anything else (an unknown or empty pointerType) leaves the mode alone.
}

function subscribe(notify: () => void) {
  if (subscribers.size === 0 && typeof window !== 'undefined') {
    // Capture phase, so the mode is settled before any component's own handler
    // for the same interaction runs. Passive: this never calls preventDefault.
    window.addEventListener('pointerdown', handlePointer, { capture: true, passive: true });
    window.addEventListener('pointermove', handlePointer, { capture: true, passive: true });
  }
  subscribers.add(notify);
  return () => {
    subscribers.delete(notify);
    if (subscribers.size === 0 && typeof window !== 'undefined') {
      window.removeEventListener('pointerdown', handlePointer, { capture: true });
      window.removeEventListener('pointermove', handlePointer, { capture: true });
    }
  };
}

const getSnapshot = () => mode;
// The server has no pointer; 'mouse' keeps hover markup in the initial HTML.
const getServerSnapshot = (): InputMode => 'mouse';

/** The input in use right now. Re-renders the caller when it changes. */
export function useInputMode(): InputMode {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export const __inputModeTesting = {
  /** Re-read the device and drop any interaction history. */
  reset() {
    mode = initialMode();
    subscribers.forEach((notify) => notify());
  },
  current: () => mode,
  subscriberCount: () => subscribers.size,
};
