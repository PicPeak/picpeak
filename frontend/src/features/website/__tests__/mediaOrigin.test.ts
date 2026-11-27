/**
 * Same-origin installs keep the real hero video in the preview (issue 2618);
 * only a split origin asks for the poster.
 */
import { afterEach, expect, it } from 'vitest';
import { mediaOriginDiffers, publicSiteUrl } from '../PreviewFrame';

it('treats a relative API (the default install) as the same origin', () => {
  expect(mediaOriginDiffers()).toBe(false);
});

const dev = globalThis as { __PICPEAK_DEV_SITE_ORIGIN__?: string };
afterEach(() => { delete dev.__PICPEAK_DEV_SITE_ORIGIN__; });

it('opens the site on the admin origin of a same-origin install', () => {
  expect(publicSiteUrl()).toBe(`${window.location.origin}/`);
});

it('opens the site on the backend the Vite dev server proxies to', () => {
  dev.__PICPEAK_DEV_SITE_ORIGIN__ = 'http://localhost:3001';
  expect(publicSiteUrl()).toBe('http://localhost:3001/');
});

it('prefers the configured public address, but not over the dev server override', () => {
  expect(publicSiteUrl('https://photos.example')).toBe('https://photos.example/');
  dev.__PICPEAK_DEV_SITE_ORIGIN__ = 'http://localhost:3001';
  expect(publicSiteUrl('https://photos.example')).toBe('http://localhost:3001/');
});
