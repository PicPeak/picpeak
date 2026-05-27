/**
 * Cleanup helper for legacy gallery-auth artefacts.
 *
 * Removes pre-multi-gallery storage:
 *   - global `gallery_token` / `gallery_event` keys in localStorage AND
 *     sessionStorage (the old single-gallery shape).
 *   - the bare `gallery_token` cookie (now replaced by slug-scoped
 *     `gallery_token_<slug>` cookies).
 *
 * Does NOT wipe slug-scoped sessionStorage entries any more — the
 * previous version did, which broke the customer-dashboard → gallery
 * handoff. CustomerDashboardPage stores
 * `sessionStorage.gallery_token_<slug>` immediately before navigating
 * to /gallery/<slug>; GalleryAuthProvider then mounts and ran this
 * cleanup as its first effect, wiping the just-set entry and forcing
 * the user back to the per-event password prompt even though their
 * customer JWT had just been exchanged for a valid gallery JWT.
 *
 * Slug-scoped storage is owned by GalleryAuthProvider itself (cleared
 * on logout, token invalidation, archived event) — this helper has
 * no business sweeping it.
 */
export const cleanupOldGalleryAuth = () => {
  // Legacy global keys (pre-multi-gallery shape).
  localStorage.removeItem('gallery_event');
  localStorage.removeItem('gallery_token');
  sessionStorage.removeItem('gallery_event');
  sessionStorage.removeItem('gallery_token');

  // Legacy bare cookie (path=/, no slug suffix). Slug-scoped
  // `gallery_token_<slug>` cookies are kept — they're how the customer
  // dashboard hands off auth to /gallery/<slug>.
  document.cookie = 'gallery_token=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;';

  // gallery_active_slug is a UI hint, not auth. Safe to drop.
  sessionStorage.removeItem('gallery_active_slug');
};
