/**
 * Utility functions for URL handling in production environments
 */

const ABSOLUTE_URL_REGEX = /^https?:\/\//i;
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

const isBrowser = typeof window !== 'undefined' && typeof window.location !== 'undefined';

const normalizeBase = (value: string): string => value.replace(/\/+$/, '');

const getEnvApiUrl = (): string | undefined => {
  const raw = import.meta.env?.VITE_API_URL;
  if (!raw || raw === '') {
    return undefined;
  }
  if (raw === '/') {
    return '/api';
  }
  return raw;
};

const isLocalHostname = (hostname: string): boolean => LOCAL_HOSTNAMES.has(hostname.toLowerCase());

const shouldFallbackToRelative = (url: string): boolean => {
  if (!ABSOLUTE_URL_REGEX.test(url)) {
    return false;
  }

  if (!isBrowser) {
    return false;
  }

  try {
    const parsed = new URL(url);
    const envHostIsLocal = isLocalHostname(parsed.hostname);
    const browserHost = window.location.hostname?.toLowerCase?.() ?? '';
    const browserHostIsLocal = isLocalHostname(browserHost);

    // Only fallback when the build-time URL points to localhost/loopback
    // but the runtime browser location is remote (non-local).
    return envHostIsLocal && !browserHostIsLocal;
  } catch {
    return false;
  }
};

const buildFromOrigin = (path: string): string => {
  if (!isBrowser) {
    return path;
  }
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${window.location.origin}${normalizedPath}`;
};

/**
 * Get the base API URL, preferring relative URLs for production and
 * falling back to relative when the build was created with localhost
 * endpoints but is being accessed from a remote browser.
 * @returns The API base URL
 */
export const getApiBaseUrl = (): string => {
  const envUrl = getEnvApiUrl();

  if (envUrl && envUrl !== '/api') {
    if (ABSOLUTE_URL_REGEX.test(envUrl) && shouldFallbackToRelative(envUrl)) {
      return '/api';
    }
    return envUrl;
  }

  return '/api';
};

const buildFromAbsoluteApi = (base: string, path: string): string => {
  const trimmedBase = normalizeBase(base);

  // When the path already targets /api we want to preserve the suffix
  if (path.startsWith('/api')) {
    const pathWithoutLeadingApi = path.replace(/^\/api/, '');
    return `${trimmedBase}${pathWithoutLeadingApi}`;
  }

  // For non-API assets (uploads, thumbnails, etc.) drop any /api suffix
  const origin = trimmedBase.replace(/\/api$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${origin}${normalizedPath}`;
};

/**
 * Build a full URL for resources (images, files, etc.)
 * In production, this will prefer the current origin unless an absolute
 * API URL is explicitly configured and applicable.
 * @param path - The resource path
 * @returns The full URL
 */
export const buildResourceUrl = (path: string): string => {
  if (!path) {
    return '';
  }

  // Absolute paths (http/https) should generally be respected,
  // except when they point to localhost but we're running remotely.
  if (ABSOLUTE_URL_REGEX.test(path)) {
    if (!shouldFallbackToRelative(path)) {
      return path;
    }

    try {
      const parsed = new URL(path);
      return buildFromOrigin(`${parsed.pathname}${parsed.search}${parsed.hash}`);
    } catch {
      return path;
    }
  }

  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const apiBase = getApiBaseUrl();

  if (ABSOLUTE_URL_REGEX.test(apiBase)) {
    return buildFromAbsoluteApi(apiBase, normalizedPath);
  }

  return buildFromOrigin(normalizedPath);
};

/**
 * Check if we're in production mode (using relative URLs)
 * @returns True if in production mode
 */
export const isProductionMode = (): boolean => {
  const apiBase = getApiBaseUrl();
  return !ABSOLUTE_URL_REGEX.test(apiBase);
};

/**
 * Build a fully-qualified gallery share URL from the value stored in
 * `events.share_link`. The DB stores the relative path (e.g.
 * `/gallery/<slug>/<token>`); for display and clipboard copy we need an
 * absolute URL the recipient can paste into a browser. Absolute inputs are
 * passed through (with the same localhost-fallback rule used elsewhere).
 *
 * @param link - The relative or absolute share link
 * @returns A fully-qualified URL, or `'#'` if input is empty
 */
export const buildShareLinkUrl = (link: string | null | undefined): string => {
  if (!link) return '#';

  if (ABSOLUTE_URL_REGEX.test(link)) {
    if (!shouldFallbackToRelative(link)) return link;
    try {
      const parsed = new URL(link);
      return buildFromOrigin(`${parsed.pathname}${parsed.search}${parsed.hash}`);
    } catch {
      return link;
    }
  }

  const path = link.startsWith('/') ? link : `/gallery/${link}`;
  return buildFromOrigin(path);
};
