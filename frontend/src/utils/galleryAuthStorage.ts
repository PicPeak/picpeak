import { safeGetItem, safeRemoveItem, safeSetItem } from './safeStorage';

const TOKEN_STORAGE_PREFIX = 'gallery_token_';
const ACTIVE_SLUG_KEY = 'gallery_active_slug';

const isBrowser = typeof window !== 'undefined';

const extractSlugFromPath = (path: string): string | null => {
  if (!path) return null;
  const match = path.match(/\/gallery\/([^\/?#]+)/);
  return match ? decodeURIComponent(match[1]) : null;
};

export const inferGallerySlugFromLocation = (): string | null => {
  if (!isBrowser) return null;
  return extractSlugFromPath(window.location.pathname);
};

export const setActiveGallerySlug = (slug: string | null) => {
  if (slug) {
    safeSetItem('session', ACTIVE_SLUG_KEY, slug);
  } else {
    safeRemoveItem('session', ACTIVE_SLUG_KEY);
  }
};

export const getActiveGallerySlug = (): string | null => safeGetItem('session', ACTIVE_SLUG_KEY);

export const clearActiveGallerySlug = () => {
  safeRemoveItem('session', ACTIVE_SLUG_KEY);
};

export const storeGalleryToken = (slug: string, token: string) => {
  if (!slug) return;
  safeSetItem('session', `${TOKEN_STORAGE_PREFIX}${slug}`, token);
};

export const getGalleryToken = (slug?: string | null): string | null => {
  const resolvedSlug = slug || getActiveGallerySlug() || inferGallerySlugFromLocation();
  if (!resolvedSlug) return null;
  return safeGetItem('session', `${TOKEN_STORAGE_PREFIX}${resolvedSlug}`);
};

export const clearGalleryToken = (slug?: string | null) => {
  if (slug) {
    safeRemoveItem('session', `${TOKEN_STORAGE_PREFIX}${slug}`);
    return;
  }

  const active = safeGetItem('session', ACTIVE_SLUG_KEY);
  if (active) {
    safeRemoveItem('session', `${TOKEN_STORAGE_PREFIX}${active}`);
  }
};

export const resolveSlugFromRequestUrl = (url?: string | null): string | null => {
  if (!url) return null;
  let pathname = url;

  try {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      pathname = new URL(url).pathname;
    }
  } catch {
    // Leave pathname as provided if URL parsing fails
  }

  if (!pathname.startsWith('/')) {
    pathname = `/${pathname}`;
  }

  return extractSlugFromPath(pathname);
};
