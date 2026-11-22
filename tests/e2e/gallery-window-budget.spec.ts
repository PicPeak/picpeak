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
 *
 * "4x CPU throttle" means four times slower than a reference CPU, not than
 * whatever host the run landed on: CDP's throttle multiplies the host's own
 * speed, so a runner image 1.5x slower turned a green 80 ms into a red 125 ms
 * with no change in the app (issue 2569). Before throttling, each test times a
 * fixed workload (`benchmark`) and throttles by
 * CPU_THROTTLE * REFERENCE_BENCH_MS / measured, clamped to [1, CPU_THROTTLE].
 * A host slower than the reference gets less extra throttling; one so slow that
 * even rate 1 leaves it more than CPU_THROTTLE times behind the reference gets
 * the rest as a larger long-task budget, at most MAX_BUDGET_SCALE times.
 *
 * Why a real regression still fails: the rate is derived from a workload that
 * does not touch the app, so a layout that does twice the work still takes
 * twice as long at the same effective speed. The green longest tasks (54-86 ms)
 * would become 108-172 ms, over the budget on a slow host as on a reference
 * one. A host faster than the reference stays at CPU_THROTTLE (the clamp), so
 * it is held to a little less than 4x the reference; the CI runner class is the
 * reference, so CI keeps the full margin.
 */
const PHOTOS = 2000;
const MAX_DOM_NODES = 3000;
const MAX_LONG_TASK_MS = 100;
const CPU_THROTTLE = 4;
/**
 * The median `benchmark` time, unthrottled, on the runner class the budget was
 * set on (ubuntu-24.04 image 20261116.133.1, whose green nightlies booted the
 * app in 730-810 ms at 4x). Obtained by running this spec on an Apple M4 Max:
 * benchmark 29-32 ms (median 30) with the app booting in ~490 ms at 4x, so the
 * runner, ~770 / 490 = 1.57x slower, benchmarks at 30 * 1.57 = 47 ms.
 * Re-baseline: take the median "bench" from the log of a green nightly on the
 * runner class that should be the reference and put it here.
 */
const REFERENCE_BENCH_MS = 47;
/** The most a too-slow host's long-task budget is stretched (150 ms). */
const MAX_BUDGET_SCALE = 1.5;

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

/**
 * Times a fixed, deterministic workload in the page, unthrottled: the median
 * of five runs after a warm-up, in ms. Object allocation, string building,
 * sorting, JSON and a hash loop, roughly the mix of booting and laying out the
 * app (Lighthouse's benchmarkIndex works the same way). Changing it changes
 * what REFERENCE_BENCH_MS means; re-baseline after.
 */
async function benchmark(page: Page) {
  return page.evaluate(() => {
    const run = () => {
      const start = performance.now();
      const rows = Array.from({ length: 50000 }, (_, index) => ({
        id: index,
        name: `IMG_${(index * 7919) % 50000}.jpg`,
        width: 1000 + ((index * 31) % 5000),
      }));
      rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const text = JSON.stringify(rows);
      const parsed = JSON.parse(text) as Array<{ width: number }>;
      let hash = 2166136261;
      for (let index = 0; index < text.length; index += 1) {
        hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
      }
      const sum = parsed.reduce((total, row) => total + row.width, 0);
      return { ms: performance.now() - start, check: (hash ^ sum) >>> 0 };
    };
    run();
    const times = Array.from({ length: 5 }, () => run().ms).sort((a, b) => a - b);
    return times[2];
  });
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
  // One retry on CI only: a shared runner sometimes stalls a frame past the
  // budget, while a real regression fails both attempts. A pass on the retry
  // shows up as flaky in the report. The budget itself stays as it is.
  test.describe.configure({ retries: process.env.CI ? 1 : 0 });

  for (const { name, layout, settings = {}, category } of CASES) {
    test(`${name}: ${PHOTOS} photos stay under ${MAX_DOM_NODES} nodes without a long task`, async ({ page, context }) => {
      const bench = await benchmark(page);
      // How many times slower than the reference the host is (above 1) or faster.
      const hostFactor = bench / REFERENCE_BENCH_MS;
      const rate = Math.min(CPU_THROTTLE, Math.max(1, CPU_THROTTLE / hostFactor));
      // Above 1 only when even rate 1 leaves the host past CPU_THROTTLE.
      const budgetScale = Math.min(MAX_BUDGET_SCALE, Math.max(1, hostFactor / CPU_THROTTLE));
      const maxLongTask = MAX_LONG_TASK_MS * budgetScale;
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate });
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
        + `longest task ${Math.round(longest)} ms (${longTasks} long), ${Math.round(longestAtLoad)} ms at load; `
        + `bench ${bench.toFixed(1)} ms (reference ${REFERENCE_BENCH_MS}), throttle ${rate.toFixed(2)}x, `
        + `long-task budget ${Math.round(maxLongTask)} ms`
        + (hostFactor / CPU_THROTTLE > MAX_BUDGET_SCALE ? ' (capped: host too slow to hold to 4x reference)' : ''));

      // All 2000 are laid out, whatever is mounted: at least 100 rows of them.
      expect(scrolled).toBeGreaterThan(100 * 100);
      expect(atRest).toBeLessThan(MAX_DOM_NODES);
      expect(maxNodes).toBeLessThan(MAX_DOM_NODES);
      expect(longest).toBeLessThan(maxLongTask);
    });
  }
});
