import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { getApiBaseUrl, buildResourceUrl, buildAdminPreviewUrl, buildShareLinkUrl, buildPublicUrl, resolvePublicBaseUrl } from '../url';
const originalLocation = window.location;

const setLocation = (origin: string) => {
  const parsed = new URL(origin);
  Object.defineProperty(window, 'location', {
    value: {
      origin: parsed.origin,
      hostname: parsed.hostname,
      href: parsed.href,
    },
    configurable: true,
  });
};

describe('url utilities', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    setLocation('https://example.com');
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      configurable: true,
    });
  });

  it('returns relative API base by default', () => {
    vi.unstubAllEnvs();
    expect(getApiBaseUrl()).toBe('/api');
    expect(buildResourceUrl('/api/gallery/test')).toBe('https://example.com/api/gallery/test');
  });

  it('honours absolute API URLs for non-local hosts', () => {
    vi.stubEnv('VITE_API_URL', 'https://api.picpeak.cloud/api');
    expect(getApiBaseUrl()).toBe('https://api.picpeak.cloud/api');
    expect(buildResourceUrl('/api/gallery/test')).toBe('https://api.picpeak.cloud/api/gallery/test');
    expect(buildResourceUrl('/uploads/logo.png')).toBe('https://api.picpeak.cloud/uploads/logo.png');
  });

  it('falls back to relative when build-time URL is localhost but browser host is remote', () => {
    vi.stubEnv('VITE_API_URL', 'http://localhost:3001/api');
    setLocation('https://photos.example.com');
    expect(getApiBaseUrl()).toBe('/api');
    expect(buildResourceUrl('/api/gallery/test')).toBe('https://photos.example.com/api/gallery/test');
    expect(buildResourceUrl('uploads/logo.png')).toBe('https://photos.example.com/uploads/logo.png');
  });

  it('keeps localhost API URL when browser is also localhost', () => {
    vi.stubEnv('VITE_API_URL', 'http://127.0.0.1:3001/api');
    setLocation('http://127.0.0.1:3000');
    expect(getApiBaseUrl()).toBe('http://127.0.0.1:3001/api');
    expect(buildResourceUrl('/api/gallery/test')).toBe('http://127.0.0.1:3001/api/gallery/test');
  });

  // Issue 2630: the admin panel is open on an internal origin, guests reach
  // the install on the configured public site URL.
  describe('public site URL', () => {
    beforeEach(() => setLocation('https://galerie.int.example.com/admin/events/1'));

    it('uses a configured site URL instead of the browser origin', () => {
      expect(resolvePublicBaseUrl('https://galerie.example.com/')).toBe('https://galerie.example.com');
      expect(resolvePublicBaseUrl(' https://galerie.example.com ')).toBe('https://galerie.example.com');
    });

    it('falls back to the browser origin without a site URL', () => {
      expect(resolvePublicBaseUrl(null)).toBe('https://galerie.int.example.com');
      expect(resolvePublicBaseUrl(undefined)).toBe('https://galerie.int.example.com');
      expect(resolvePublicBaseUrl('')).toBe('https://galerie.int.example.com');
    });

    it('falls back to the browser origin for an invalid site URL', () => {
      expect(resolvePublicBaseUrl('galerie.example.com')).toBe('https://galerie.int.example.com');
      expect(resolvePublicBaseUrl('ftp://galerie.example.com')).toBe('https://galerie.int.example.com');
      expect(resolvePublicBaseUrl('https://')).toBe('https://galerie.int.example.com');
    });

    it('anchors a share link on the public base', () => {
      const base = resolvePublicBaseUrl('https://galerie.example.com');
      expect(buildShareLinkUrl('/gallery/wed/tok', base)).toBe('https://galerie.example.com/gallery/wed/tok');
      expect(buildShareLinkUrl('wed/tok', base)).toBe('https://galerie.example.com/gallery/wed/tok');
      expect(buildShareLinkUrl('/code', base)).toBe('https://galerie.example.com/code');
      expect(buildShareLinkUrl(null, base)).toBe('#');
    });

    it('keeps a stored absolute share link as it is', () => {
      const base = resolvePublicBaseUrl('https://galerie.example.com');
      expect(buildShareLinkUrl('https://other.example.org/gallery/wed', base)).toBe('https://other.example.org/gallery/wed');
    });

    it('keeps the browser origin when no public base is passed', () => {
      expect(buildShareLinkUrl('/gallery/wed/tok')).toBe('https://galerie.int.example.com/gallery/wed/tok');
      expect(buildPublicUrl('/s/short')).toBe('https://galerie.int.example.com/s/short');
    });

    it('builds other public links on the base', () => {
      expect(buildPublicUrl('/s/short', 'https://galerie.example.com/')).toBe('https://galerie.example.com/s/short');
      expect(buildPublicUrl('book', 'https://galerie.example.com')).toBe('https://galerie.example.com/book');
    });

    it('leaves the admin preview link on the browser origin', () => {
      expect(buildAdminPreviewUrl('/gallery/wed/tok')).toBe('https://galerie.int.example.com/gallery/wed/tok?admin_preview=1');
    });
  });

  describe('buildAdminPreviewUrl', () => {
    it('adds the admin preview flag to a slug share link', () => {
      expect(buildAdminPreviewUrl('wedding-2026/abc123')).toBe('https://example.com/gallery/wedding-2026/abc123?admin_preview=1');
    });

    it('appends with & when the share link already has a query', () => {
      expect(buildAdminPreviewUrl('/gallery/wed?token=abc')).toBe('https://example.com/gallery/wed?token=abc&admin_preview=1');
    });

    it('keeps a hash after the flag', () => {
      expect(buildAdminPreviewUrl('https://example.com/gallery/wed#top')).toBe('https://example.com/gallery/wed?admin_preview=1#top');
    });

    it('returns # for a missing share link', () => {
      expect(buildAdminPreviewUrl(null)).toBe('#');
      expect(buildAdminPreviewUrl('')).toBe('#');
    });
  });
});
