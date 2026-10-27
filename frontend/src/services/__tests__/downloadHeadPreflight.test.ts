/**
 * Issue 2304: a direct video download hands the response to the browser, so
 * the app never saw a refusal. A HEAD goes first, through the real axios
 * instance and its interceptors: a 200 clicks the link, any error rejects
 * without clicking (the caller shows its error toast), and a 401 runs the
 * usual interceptor handling (the admin login redirect, the guest's stored
 * gallery session dropped).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import { api } from '../../config/api';
import { photosService } from '../photos.service';
import { galleryService } from '../gallery.service';

const originalAdapter = api.defaults.adapter;
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15';

let requests: InternalAxiosRequestConfig[];
let clicked: HTMLAnchorElement[];

function answer(status: number) {
  const adapter: AxiosAdapter = async (config) => {
    requests.push(config);
    const response = { status, statusText: '', headers: {}, config, data: '' };
    if (status < 400) return response;
    throw new AxiosError(`Request failed with status code ${status}`, AxiosError.ERR_BAD_REQUEST, config, {}, response);
  };
  api.defaults.adapter = adapter;
}

const fakeLocation = (pathname: string) => {
  const location = { pathname, search: '', href: `http://localhost${pathname}` };
  vi.stubGlobal('location', location);
  return location;
};

beforeEach(() => {
  requests = [];
  clicked = [];
  Object.defineProperty(navigator, 'userAgent', { value: DESKTOP_UA, configurable: true });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push(this);
  });
});

afterEach(() => {
  api.defaults.adapter = originalAdapter;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('admin video download preflight (issue 2304)', () => {
  it('sends a HEAD to the download route, then clicks the link', async () => {
    answer(200);
    await photosService.downloadPhoto(3, 11, 'clip.mp4', true);

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('head');
    expect(requests[0].url).toBe('/admin/events/3/photos/11/download');
    expect(clicked).toHaveLength(1);
    expect(clicked[0].getAttribute('href')).toMatch(/\/admin\/events\/3\/photos\/11\/download$/);
  });

  it('rejects on a 404 and never clicks the link', async () => {
    answer(404);
    await expect(photosService.downloadPhoto(3, 11, 'clip.mp4', true)).rejects.toMatchObject({
      response: { status: 404 },
    });
    expect(clicked).toHaveLength(0);
  });

  it('rejects on a 401, never clicks the link, and redirects to the admin login', async () => {
    const location = fakeLocation('/admin/events/3');
    answer(401);
    await expect(photosService.downloadPhoto(3, 11, 'clip.mp4', true)).rejects.toMatchObject({
      response: { status: 401 },
    });
    expect(clicked).toHaveLength(0);
    expect(location.href).toBe('/admin/login');
  });
});

describe('guest direct download preflight (issue 2304)', () => {
  it('sends a HEAD with the gallery token and the picked size, then clicks the link', async () => {
    answer(200);
    await galleryService.downloadPhoto('party', 9, 'clip.mp4', undefined, '1920x1080', true);

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('head');
    expect(requests[0].url).toBe('/gallery/party/download/9');
    expect(requests[0].params).toEqual({ resolution: '1920x1080' });
    expect(clicked).toHaveLength(1);
    expect(clicked[0].getAttribute('href')).toMatch(/\/gallery\/party\/download\/9\?resolution=1920x1080$/);
  });

  it.each([
    ['downloadPhoto (grid tile)', () => galleryService.downloadPhoto('party', 9, 'clip.mp4', undefined, undefined, true)],
    ['savePhotoToDevice (lightbox)', () => galleryService.savePhotoToDevice('party', 9, 'clip.mp4', undefined, undefined, true)],
  ])('%s rejects on a 404 and never clicks the link', async (_name, run) => {
    answer(404);
    await expect(run()).rejects.toMatchObject({ response: { status: 404 } });
    expect(clicked).toHaveLength(0);
  });

  it('rejects on a 401, never clicks the link, and drops the stored gallery session', async () => {
    const location = fakeLocation('/gallery/party');
    sessionStorage.setItem('gallery_event_party', '{"id":1}');
    answer(401);

    await expect(galleryService.downloadPhoto('party', 9, 'clip.mp4', undefined, undefined, true)).rejects.toMatchObject({
      response: { status: 401 },
    });
    expect(clicked).toHaveLength(0);
    expect(sessionStorage.getItem('gallery_event_party')).toBeNull();
    // On a gallery page the guest stays put; the page shows the login itself.
    expect(location.href).toBe('http://localhost/gallery/party');
  });
});
