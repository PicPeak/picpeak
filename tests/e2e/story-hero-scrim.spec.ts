import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';

/**
 * Issue 2254: the Story hero scrim was the copy box's own background. It was
 * still partly dark where the box ended, so a rounded edge showed around the
 * title on detailed hero images. This renders the real stylesheet over a flat
 * grey hero and reads the pixels back: along lines through the copy the
 * darkening must change smoothly (no step at any edge) and only grow towards
 * the centre, while the copy box itself stays clearly darkened.
 *
 * It needs no app stack: the hero markup mirrors StoryHero.tsx and the CSS is
 * the shipped file, so it runs in the PR smoke set.
 */

const CSS = fs.readFileSync(
  path.resolve(__dirname, '../../frontend/src/components/gallery/layouts/GalleryStoryLayout.css'),
  'utf8',
);

const GREY = 128;

async function renderHero(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  // Text is transparent so the samples measure the scrim alone.
  await page.setContent(`<!doctype html><html><head><style>
    body { margin: 0; }
    ${CSS}
    .space-y-6 > * + * { margin-top: 1.5rem; }
    .story-hero-copy * { color: transparent !important; text-shadow: none !important; background: transparent !important; }
  </style></head><body>
    <div class="story-hero">
      <div class="story-hero-bg"><div style="width:100%;height:100%;background:rgb(${GREY},${GREY},${GREY})"></div></div>
      <div class="story-hero-content">
        <div class="story-hero-copy space-y-6">
          <p class="story-hero-date">Saturday, 10 October 2026</p>
          <h1 class="story-hero-title">Sarah &amp; Tom in Lisbon</h1>
          <div class="story-hero-stats"><span class="story-hero-stats-divider"></span><span>248 Photos</span><span class="story-hero-stats-divider"></span></div>
        </div>
      </div>
    </div>
  </body></html>`);
}

type Line = { values: number[]; copyFrom: number; copyTo: number };

/** Grey levels along the row, the column and the diagonal through the copy. */
async function sampleLines(page: Page) {
  const box = (await page.locator('.story-hero-copy').boundingBox())!;
  const shot = (await page.screenshot()).toString('base64');
  return page.evaluate(async ({ shot, box }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${shot}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, img.width, img.height);
    const at = (x: number, y: number) => data[(Math.round(y) * width + Math.round(x)) * 4];
    // The screenshot is in device pixels; the box is in CSS pixels.
    const k = img.width / window.innerWidth;
    const b = { x: box.x * k, y: box.y * k, width: box.width * k, height: box.height * k };
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    const row = { values: [] as number[], copyFrom: Math.round(b.x), copyTo: Math.round(b.x + b.width) };
    for (let x = 0; x < width; x++) row.values.push(at(x, cy));
    const column = { values: [] as number[], copyFrom: Math.round(b.y), copyTo: Math.round(b.y + b.height) };
    for (let y = 0; y < height; y++) column.values.push(at(cx, y));
    // Corner to corner of the copy box, extended to the hero's edge.
    const diagonal = { values: [] as number[], copyFrom: -1, copyTo: -1 };
    const dx = b.width / 2;
    const dy = b.height / 2;
    const unit = Math.hypot(dx, dy);
    for (let i = -width - height; i <= width + height; i++) {
      const x = cx + (dx * i) / unit;
      const y = cy + (dy * i) / unit;
      if (x < 0 || y < 0 || x > width - 1 || y > height - 1) continue;
      if (Math.abs(x - cx) < dx - 1 && Math.abs(y - cy) < dy - 1) {
        if (diagonal.copyFrom < 0) diagonal.copyFrom = diagonal.values.length;
        diagonal.copyTo = diagonal.values.length + 1;
      }
      diagonal.values.push(at(x, y));
    }
    return { row, column, diagonal };
  }, { shot, box });
}

function expectSmoothScrim(name: string, line: Line) {
  const { values, copyFrom, copyTo } = line;
  const darkest = values.indexOf(Math.min(...values));
  for (let i = 1; i < values.length; i++) {
    // A gradient moves one grey level per step at most; the old scrim's edge
    // jumped by about twenty.
    expect(Math.abs(values[i] - values[i - 1]), `${name}: step at ${i}`).toBeLessThanOrEqual(2);
    // Lighter (or equal) moving away from the darkest point, give or take dithering.
    if (i <= darkest) expect(values[i], `${name}: darkens towards the centre at ${i}`).toBeLessThanOrEqual(values[i - 1] + 1);
    else expect(values[i], `${name}: lightens away from the centre at ${i}`).toBeGreaterThanOrEqual(values[i - 1] - 1);
  }
  // Legibility from issue 1708: the middle of the copy box, where the text
  // sits, stays darkened. The outer part of the box is where the scrim
  // fades out.
  const inset = Math.round((copyTo - copyFrom) / 4);
  for (let i = copyFrom + inset; i < copyTo - inset; i++) {
    expect(values[i], `${name}: copy darkened at ${i}`).toBeLessThanOrEqual(GREY * 0.9);
  }
  expect(Math.min(...values)).toBeLessThanOrEqual(GREY * 0.5);
}

for (const [label, width, height] of [['desktop', 1440, 900], ['phone', 390, 844]] as const) {
  test(`Story hero scrim fades out without a visible edge on ${label} @smoke`, async ({ page }) => {
    await renderHero(page, width, height);
    const { row, column, diagonal } = await sampleLines(page);
    expectSmoothScrim('row', row);
    expectSmoothScrim('column', column);
    expectSmoothScrim('diagonal', diagonal);
    // The oversized layer is clipped by the hero, never scrolls the page.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBe(0);
  });
}
