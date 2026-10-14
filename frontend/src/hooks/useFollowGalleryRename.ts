import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * Follow a renamed gallery to its new slug.
 *
 * Renaming a gallery rewrites its slug and records the old one in
 * slug_redirects. `/api/gallery/:slug/info` answers the old slug with a 301
 * whose JSON body names the new slug (no Location header, so the browser does
 * not follow it and axios rejects it as a non-2xx). Every link sent before
 * the rename, `/gallery/<old-slug>/<token>` included, used to land on
 * "gallery not found".
 *
 * Only the slug segment is swapped: the rest of the path (share token,
 * `/client-access`), the query and the hash are kept. Hops are counted in the
 * history state so a redirect cycle stops after a few and the page falls back
 * to its not-found state.
 */
export const MAX_GALLERY_RENAME_HOPS = 3;

/** The new slug a 301 "gallery has been renamed" answer names, or null. */
export function renamedGallerySlug(error: unknown): string | null {
  const response = (error as { response?: { status?: number; data?: unknown } } | null)?.response;
  if (response?.status !== 301) return null;
  const data = response.data as { redirect?: unknown; newSlug?: unknown } | undefined;
  if (data?.redirect !== true || typeof data.newSlug !== 'string') return null;
  const slug = data.newSlug.trim();
  // A slug is one path segment; anything that could leave it is ignored.
  if (!slug || slug === '.' || slug === '..' || /[/\\?#]/.test(slug)) return null;
  return slug;
}

/** `pathname` with its /gallery/<slug> segment replaced, or null if it has none. */
export function renamedGalleryPath(pathname: string, newSlug: string): string | null {
  const match = /^\/gallery\/[^/]+(\/.*)?$/.exec(pathname);
  if (!match) return null;
  return `/gallery/${encodeURIComponent(newSlug)}${match[1] ?? ''}`;
}

/**
 * Navigates (replacing the history entry) when `error` is a rename answer.
 * `errorSlug` is the slug whose /info request produced `error`. Returns true
 * while that navigation is pending, so the caller can keep showing its
 * loading state instead of flashing "not found".
 */
export function useFollowGalleryRename(error: unknown, errorSlug: string | null | undefined): boolean {
  const location = useLocation();
  const navigate = useNavigate();
  const state = location.state as { galleryRenameHops?: unknown } | null;
  const hops = typeof state?.galleryRenameHops === 'number' ? state.galleryRenameHops : 0;

  const named = renamedGallerySlug(error);
  // A redirect to the slug that was asked for (A→B→A leaves A→A behind once
  // the gallery is gone) leads nowhere: treat it as not found, not as a
  // pending move.
  const newSlug = named && named !== errorSlug ? named : null;
  const newPath = newSlug ? renamedGalleryPath(location.pathname, newSlug) : null;
  // Already on the new path: the page still holds the old slug's answer for
  // the render before its own query moves on, which is not a "not found".
  const arrived = newPath !== null && newPath === location.pathname;
  const target = newPath && !arrived && hops < MAX_GALLERY_RENAME_HOPS ? newPath : null;

  useEffect(() => {
    if (!target) return;
    navigate(
      { pathname: target, search: location.search, hash: location.hash },
      { replace: true, state: { ...(location.state as object | null), galleryRenameHops: hops + 1 } },
    );
  }, [target, hops, navigate, location.search, location.hash, location.state]);

  return target !== null || arrived;
}
