import { test, expect, type Page } from '@playwright/test';

/**
 * The budget of a windowed gallery (issue 2193): with 2000 photos at 4x CPU
 * throttle, under 3000 DOM nodes and no long task of 100 ms or more.
 *
 * The app is real, the API is not: every /api call is answered here, so the
 * spec needs no 2000-photo gallery and no seeding, and runs against anything
 * that serves the frontend. Thumbnails are one small image, so what is measured
 * is the layout and not image decoding.
 *
 * The long tasks held to the budget are those of scrolling through the
 * gallery, from one end to the other and back. Booting the app and parsing the
 * list are not the layout's to answer for, so the longest task up to then goes
 * to the log only.
 */
const PHOTOS = 2000;
const MAX_DOM_NODES = 3000;
const MAX_LONG_TASK_MS = 100;
const CPU_THROTTLE = 4;

const SLUG = 'budget-gallery';
// A 1x1 GIF.
const TILE_IMAGE = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

const SHAPES = [[6000, 4000], [6000, 4000], [4000, 6000], [4000, 3000], [3000, 4000], [1920, 1080], [3000, 3000], [7000, 2000]];

const makePhotos = (category: (index: number) => string = () => '') => Array.from({ length: PHOTOS }, (_, index) => {
  const id = index + 1;
  const [width, height] = SHAPES[(index * 7) % SHAPES.length];
  return {
    id,
    filename: `IMG_${id}.jpg`,
    original_filename: `IMG_${id}.jpg`,
    url: `/api/gallery/${SLUG}/photo/${id}`,
    thumbnail_url: `/api/gallery/${SLUG}/thumbnail/${id}`,
    type: 'individual',
    media_type: 'image',
    size: 1000,
    uploaded_at: '2026-01-01T12:00:00.000Z',
    width,
    height,
    category_name: category(index),
  };
});

const event = (colorTheme: string) => ({
  id: 1,
  event_name: 'Budget gallery',
  event_type: 'wedding',
  event_date: '2026-01-01',
  expires_at: null,
  require_password: false,
  allow_downloads: true,
  color_theme: colorTheme,
});

/** Answers every API call. An endpoint nobody listed gets an empty object. */
async function stubApi(page: Page, gallerySettings: Record<string, unknown>, galleryLayout: string, photos: unknown[]) {
  const colorTheme = JSON.stringify({ galleryLayout, gallerySettings, headerStyle: 'standard', footerStyle: 'standard' });
  await page.route('**/api/**', (route) => {
    const { pathname, searchParams } = new URL(route.request().url());
    const json = (body: unknown) => route.fulfill({ json: body });
    if (pathname.endsWith('/auth/session')) return json({ valid: false });
    if (pathname.endsWith('/auth/gallery/verify')) return json({ token: 'budget-token', event: event(colorTheme) });
    if (pathname.endsWith(`/gallery/${SLUG}/info`)) {
      return json({ ...event(colorTheme), is_active: true, is_expired: false, requires_password: false });
    }
    if (pathname.endsWith(`/gallery/${SLUG}/photos`)) {
      const limit = Number(searchParams.get('limit') || 250);
      const pageNumber = Number(searchParams.get('page') || 1);
      const start = (pageNumber - 1) * limit;
      return json({
        event: event(colorTheme),
        categories: [],
        photos: photos.slice(start, start + limit),
        pagination: { page: pageNumber, limit, total: photos.length, has_more: start + limit < photos.length },
      });
    }
    if (/\/(thumbnail|photo)\//.test(pathname)) return route.fulfill({ contentType: 'image/gif', body: TILE_IMAGE });
    return json({});
  });
}

/** Scrolls down the gallery and back up, a viewport a frame's worth at a time. */
async function scrollThrough(page: Page) {
  return page.evaluate(async ({ steps }) => {
    const tasks: number[] = [];
    const observer = new PerformanceObserver((list) => {
      list.getEntries().forEach((entry) => tasks.push(entry.duration));
    });
    observer.observe({ entryTypes: ['longtask'] });
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    let nodes = 0;
    const count = () => { nodes = Math.max(nodes, document.getElementsByTagName('*').length); };
    const end = document.documentElement.scrollHeight - window.innerHeight;
    for (const direction of [1, -1]) {
      for (let step = 0; step <= steps; step += 1) {
        window.scrollTo(0, direction > 0 ? (end * step) / steps : end - (end * step) / steps);
        await frame();
        await frame();
        count();
      }
    }
    // A long task is reported after it ends, in a later task.
    await new Promise((resolve) => setTimeout(resolve, 200));
    observer.disconnect();
    return { longest: Math.max(0, ...tasks), longTasks: tasks.length, maxNodes: nodes, scrolled: end };
  }, { steps: 40 });
}

const CASES: Array<{ name: string; layout: string; settings?: Record<string, unknown>; category?: (index: number) => string }> = [
  { name: 'Grid', layout: 'grid' },
  { name: 'Timeline', layout: 'timeline' },
  { name: 'Masonry columns', layout: 'masonry', settings: { masonryMode: 'columns' } },
  { name: 'Masonry rows', layout: 'masonry', settings: { masonryMode: 'rows' } },
  { name: 'Masonry flickr', layout: 'masonry', settings: { masonryMode: 'flickr' } },
  { name: 'Masonry quilted', layout: 'masonry', settings: { masonryMode: 'quilted' } },
  { name: 'Mosaic', layout: 'mosaic' },
  { name: 'Premium', layout: 'gallery-premium' },
  { name: 'Story', layout: 'gallery-story' },
  { name: 'Story natural', layout: 'gallery-story', settings: { storyGridMode: 'natural' } },
];

test.describe('windowed gallery budget', () => {
  // The CDP throttle is Chromium's, and the budget is a desktop one.
  test.skip(({ browserName, isMobile }) => browserName !== 'chromium' || Boolean(isMobile), 'Chromium desktop only');
  test.setTimeout(120_000);

  for (const { name, layout, settings = {}, category } of CASES) {
    test(`${name}: ${PHOTOS} photos stay under ${MAX_DOM_NODES} nodes without a long task`, async ({ page, context }) => {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
      await stubApi(page, settings, layout, makePhotos(category));

      await page.goto(`/gallery/${SLUG}`);
      await page.waitForFunction(
        () => document.querySelector('.photo-grid, .react-photo-album, .story-gallery-grid, .story-gallery-justified') !== null,
        undefined,
        { timeout: 60_000 },
      );
      // The tiles of the first render, and the images those start.
      await page.waitForTimeout(1000);

      const atRest = await page.evaluate(() => document.getElementsByTagName('*').length);
      const longestAtLoad = await page.evaluate(() => new Promise<number>((resolve) => {
        const observer = new PerformanceObserver((list) => {
          observer.disconnect();
          resolve(Math.max(0, ...list.getEntries().map((entry) => entry.duration)));
        });
        observer.observe({ type: 'longtask', buffered: true });
        setTimeout(() => resolve(0), 500);
      }));
      const { longest, longTasks, maxNodes, scrolled } = await scrollThrough(page);
      console.log(`${name}: ${atRest} nodes at rest, ${maxNodes} at most scrolling, `
        + `longest task ${Math.round(longest)} ms (${longTasks} long), ${Math.round(longestAtLoad)} ms at load`);

      // All 2000 are laid out, whatever is mounted: at least 100 rows of them.
      expect(scrolled).toBeGreaterThan(100 * 100);
      expect(atRest).toBeLessThan(MAX_DOM_NODES);
      expect(maxNodes).toBeLessThan(MAX_DOM_NODES);
      expect(longest).toBeLessThan(MAX_LONG_TASK_MS);
    });
  }
});
