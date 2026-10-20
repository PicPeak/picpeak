/**
 * Tile density picked by the gallery viewer (issue 1733, E4).
 *
 * The admin's theme (`gridColumns`, `thumbnailScale`, the masonry row height)
 * stays the default. A guest can nudge it one step either way from the
 * gallery toolbar: "compact" adds a column, "large" takes one away, and the
 * layouts that size tiles by height rather than by column count scale that
 * height instead. "default" is no nudge at all and is never stored, so a
 * guest who goes back to it follows the theme again if the admin changes it.
 *
 * One key for the whole browser, not one per gallery slug: how big a tile
 * should be is a property of the viewer's screen and eyes, not of the event,
 * and because the choice is relative to each gallery's own theme it carries
 * over sensibly to a gallery with a different default.
 *
 * Storage can be missing or throw (private mode, blocked site data); the
 * choice then lives for the page only.
 *
 * Because the choice follows the viewer from gallery to gallery, it only
 * applies where the page also offers the switch to change it back: the page
 * that renders one says so through `GridDensityOffered`. Anywhere else (a
 * gallery whose admin hid the filter bar, the admin preview) the layouts keep
 * the theme's own size.
 */
import { createContext, useContext, useSyncExternalStore } from 'react';

export type GridDensity = 'compact' | 'default' | 'large';

export const GRID_DENSITIES: ReadonlyArray<GridDensity> = ['compact', 'default', 'large'];

export const GRID_DENSITY_STORAGE_KEY = 'picpeak.gallery.density';

/** Columns added to the theme's count, per breakpoint. */
export function densityColumnDelta(density: GridDensity): number {
  return density === 'compact' ? 1 : density === 'large' ? -1 : 0;
}

/** Factor on a tile height (masonry rows, flickr, quilted). */
export function densitySizeFactor(density: GridDensity): number {
  return density === 'compact' ? 0.75 : density === 'large' ? 1.35 : 1;
}

/**
 * Layouts where density means something. Carousel shows one photo at a
 * time; the full-page layouts (premium, story) render their own chrome
 * without the filter bar the control lives in.
 */
export function layoutHasDensity(layout: string | undefined): boolean {
  const l = layout || 'grid';
  return l === 'grid' || l === 'masonry' || l === 'mosaic' || l === 'timeline';
}

function readStored(): GridDensity {
  try {
    const raw = window.localStorage.getItem(GRID_DENSITY_STORAGE_KEY);
    if (raw === 'compact' || raw === 'large') return raw;
  } catch {
    // ignore — fall through to the theme default
  }
  return 'default';
}

let current: GridDensity | null = null;
const subscribers = new Set<() => void>();

function getSnapshot(): GridDensity {
  if (current === null) current = typeof window === 'undefined' ? 'default' : readStored();
  return current;
}

function subscribe(notify: () => void) {
  subscribers.add(notify);
  return () => { subscribers.delete(notify); };
}

export function setGridDensity(density: GridDensity): void {
  current = density;
  try {
    if (density === 'default') window.localStorage.removeItem(GRID_DENSITY_STORAGE_KEY);
    else window.localStorage.setItem(GRID_DENSITY_STORAGE_KEY, density);
  } catch {
    // ignore — quota / disabled storage; the choice still holds for this page
  }
  subscribers.forEach((notify) => notify());
}

/** True where the page renders a density switch the viewer can reach. */
export const GridDensityOffered = createContext(false);

/** The viewer's stored choice, for the switch itself. Re-renders on change. */
export function useChosenGridDensity(): GridDensity {
  return useSyncExternalStore(subscribe, getSnapshot, () => 'default' as GridDensity);
}

/**
 * The density a layout applies: the viewer's choice where the page offers
 * the switch, the theme default otherwise. Re-renders the caller on change.
 */
export function useGridDensity(): GridDensity {
  const chosen = useChosenGridDensity();
  return useContext(GridDensityOffered) ? chosen : 'default';
}

/** Test hook: forget the in-memory value so the next read hits storage. */
export function resetGridDensityForTests(): void {
  current = null;
}
