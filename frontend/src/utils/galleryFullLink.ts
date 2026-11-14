/**
 * The full link of a gallery with a curated selection (issue 2356).
 *
 * /gallery/:slug/full/:token keeps the token for this tab and sends the
 * visitor to the gallery, whose login (POST /auth/gallery/verify, with or
 * without a password) then passes it along and opens a session that sees
 * every photo. sessionStorage, not localStorage: the token is a credential
 * and should not outlive the tab on a shared device.
 */
const key = (slug: string) => `gallery_full_link_${slug}`;

export function getFullLinkToken(slug: string): string | null {
  try {
    return sessionStorage.getItem(key(slug));
  } catch {
    return null;
  }
}

export function setFullLinkToken(slug: string, token: string): void {
  try {
    sessionStorage.setItem(key(slug), token);
  } catch {
    // Private mode: the visitor gets the selection, as with the ordinary link.
  }
}

export function clearFullLinkToken(slug: string): void {
  try {
    sessionStorage.removeItem(key(slug));
  } catch {
    // nothing stored
  }
}
