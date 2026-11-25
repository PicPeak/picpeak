import { safeGetItem, safeSetItem } from '../../../utils/safeStorage';
import type { WalkthroughScope } from './walkthroughSteps';

/**
 * Whether this browser has seen a gallery's walkthrough (issue 2551), per
 * gallery and per scope: a guest who later opens the client link gets the
 * client tour once as well.
 *
 * localStorage can be missing or throw (private mode, blocked site data).
 * The in-memory set keeps the tour from coming back within the page's
 * lifetime then; a fresh load shows it again, which is the best we can do
 * without storage.
 */
const seenInMemory = new Set<string>();

export const walkthroughStorageKey = (slug: string, scope: WalkthroughScope): string =>
  `picpeak_walkthrough_${slug}_${scope}`;

export function hasSeenWalkthrough(slug: string, scope: WalkthroughScope): boolean {
  const key = walkthroughStorageKey(slug, scope);
  if (seenInMemory.has(key)) return true;
  return safeGetItem('local', key) === '1';
}

export function markWalkthroughSeen(slug: string, scope: WalkthroughScope): void {
  const key = walkthroughStorageKey(slug, scope);
  // Storage unavailable: the in-memory flag covers this page load.
  seenInMemory.add(key);
  safeSetItem('local', key, '1');
}

/** Tests only. */
export function resetWalkthroughMemory(): void {
  seenInMemory.clear();
}
