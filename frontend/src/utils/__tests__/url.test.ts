import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { getApiBaseUrl, buildResourceUrl, buildAdminPreviewUrl } from '../url';
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
