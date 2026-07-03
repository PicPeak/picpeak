const TOKEN_STORAGE_PREFIX = 'gallery_token_';
const ACTIVE_SLUG_KEY = 'gallery_active_slug';

const isBrowser = typeof window !== 'undefined';

const getSessionStorage = (): Storage | null => {
  if (!isBrowser) return null;
  try {
    return window.sessionStorage;
  } catch (error) {
    console.warn('Session storage unavailable', error);
    return null;
  }
};

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
  const storage = getSessionStorage();
  if (!storage) return;
  if (slug) {
    storage.setItem(ACTIVE_SLUG_KEY, slug);
  } else {
    storage.removeItem(ACTIVE_SLUG_KEY);
  }
};

export const getActiveGallerySlug = (): string | null => {
  const storage = getSessionStorage();
  if (!storage) return null;
  return storage.getItem(ACTIVE_SLUG_KEY);
};

export const clearActiveGallerySlug = () => {
  const storage = getSessionStorage();
  if (!storage) return;
  storage.removeItem(ACTIVE_SLUG_KEY);
};

export const storeGalleryToken = (slug: string, token: string) => {
  const storage = getSessionStorage();
  if (!storage || !slug) return;
  storage.setItem(`${TOKEN_STORAGE_PREFIX}${slug}`, token);
};

export const getGalleryToken = (slug?: string | null): string | null => {
  const storage = getSessionStorage();
  if (!storage) return null;
  const resolvedSlug = slug || getActiveGallerySlug() || inferGallerySlugFromLocation();
  if (!resolvedSlug) return null;
  return storage.getItem(`${TOKEN_STORAGE_PREFIX}${resolvedSlug}`);
};

export const clearGalleryToken = (slug?: string | null) => {
  const storage = getSessionStorage();
  if (!storage) return;

  if (slug) {
    storage.removeItem(`${TOKEN_STORAGE_PREFIX}${slug}`);
    return;
  }

  const active = storage.getItem(ACTIVE_SLUG_KEY);
  if (active) {
    storage.removeItem(`${TOKEN_STORAGE_PREFIX}${active}`);
  }
};

export const clearAllGalleryTokens = () => {
  const storage = getSessionStorage();
  if (!storage) return;

  const keysToRemove: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key && key.startsWith(TOKEN_STORAGE_PREFIX)) {
      keysToRemove.push(key);
    }
  }

  keysToRemove.forEach((key) => storage.removeItem(key));
};

export const resolveSlugFromRequestUrl = (url?: string | null): string | null => {
  if (!url) return null;
  let pathname = url;

  try {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      pathname = new URL(url).pathname;
    }
  } catch (error) {
    // Leave pathname as provided if URL parsing fails
  }

  if (!pathname.startsWith('/')) {
    pathname = `/${pathname}`;
  }

  return extractSlugFromPath(pathname);
};
