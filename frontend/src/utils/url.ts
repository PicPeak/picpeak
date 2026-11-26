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
 * The address guests and customers reach this install on (issue 2630). The
 * admin panel may be open on a different, internal origin, so a link meant for
 * someone else is anchored on the configured public site URL (FRONTEND_URL or
 * Settings > General > Site URL, as resolved by the backend), not on the
 * browser. Falls back to the browser origin when nothing valid is configured.
 *
 * @param configured - `public_site_url` from the public settings
 * @returns The base without a trailing slash, or `''` outside a browser
 */
export const resolvePublicBaseUrl = (configured: string | null | undefined): string => {
  if (configured && isAbsoluteHttpUrl(configured)) {
    return normalizeBase(configured.trim());
  }
  return isBrowser ? window.location.origin : '';
};

/**
 * An absolute URL for a path on the public address. Pass the base from
 * `usePublicBaseUrl()`; without one the browser origin is used.
 */
export const buildPublicUrl = (path: string, publicBase?: string | null): string => {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const base = publicBase ? normalizeBase(publicBase) : resolvePublicBaseUrl(null);
  return `${base}${normalizedPath}`;
};

/**
 * Build a fully-qualified gallery share URL from the value stored in
 * `events.share_link`. The DB stores the relative path (e.g.
 * `/gallery/<slug>/<token>`); for display and clipboard copy we need an
 * absolute URL the recipient can paste into a browser. Absolute inputs are
 * passed through (with the same localhost-fallback rule used elsewhere).
 *
 * @param link - The relative or absolute share link
 * @param publicBase - The public address from `usePublicBaseUrl()`; omit it
 *   only for the admin's own navigation, which stays on the browser origin
 * @returns A fully-qualified URL, or `'#'` if input is empty
 */
export const buildShareLinkUrl = (link: string | null | undefined, publicBase?: string | null): string => {
  if (!link) return '#';

  // An explicit public address (issue 2630) anchors relative links and
  // loopback-absolute ones; without it the browser origin does, as before.
  const anchor = (path: string): string => (publicBase ? buildPublicUrl(path, publicBase) : buildFromOrigin(path));

  if (ABSOLUTE_URL_REGEX.test(link)) {
    if (!shouldFallbackToRelative(link)) return link;
    try {
      const parsed = new URL(link);
      return anchor(`${parsed.pathname}${parsed.search}${parsed.hash}`);
    } catch {
      return link;
    }
  }

  const path = link.startsWith('/') ? link : `/gallery/${link}`;
  return anchor(path);
};

/**
 * The admin's own "View gallery" link (#868): the share link plus the
 * `admin_preview=1` intent flag, so the gallery lets a logged-in admin in
 * through the httpOnly admin cookie instead of asking for the guest password.
 * Never use it for a link that is copied, mailed or shown to a guest.
 *
 * @param link - The relative or absolute share link
 * @returns The share link with `admin_preview=1`, or `'#'` if input is empty
 */
export const buildAdminPreviewUrl = (link: string | null | undefined): string => {
  const url = buildShareLinkUrl(link);
  if (url === '#') return url;
  const hashAt = url.indexOf('#');
  const base = hashAt === -1 ? url : url.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : url.slice(hashAt);
  return `${base}${base.includes('?') ? '&' : '?'}admin_preview=1${hash}`;
};

/**
 * Is this an absolute http(s) origin the browser could actually navigate to?
 *
 * Used for the public address (`general_site_url`), which since #705 feeds the
 * CORS allowlist and the Access-Control-Allow-Origin header as well as every
 * email link — a schemeless "gallery.example.com" saves happily through a
 * `type="url"` input that is not inside a <form>, and then matches no browser
 * origin at all. Mirrors the backend check in adminSettings.js: a bare host or
 * IP is fine (LAN and NAS installs run on http://nas:3000), the scheme is not.
 */
export const isAbsoluteHttpUrl = (value: string): boolean => {
  if (!ABSOLUTE_URL_REGEX.test(value.trim())) {
    return false;
  }
  try {
    const parsed = new URL(value.trim());
    return !!parsed.hostname;
  } catch {
    return false;
  }
};
