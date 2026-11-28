/**
 * The page's self-hosted font loader (issue 2618: fonts uploaded in the
 * branding settings). Its list of fonts is cached for minutes; a font
 * uploaded meanwhile must still get its @font-face.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../fonts.service', async () => {
  const actual = await vi.importActual<typeof import('../fonts.service')>('../fonts.service');
  return { ...actual, fontsService: { list: vi.fn() } };
});

import { fontsService } from '../fonts.service';
import { forgetFontsList, loadFontForFamily } from '../fontLoader';

// A family per test: the loader keeps what it injected for the page's life.
const font = (family: string) => ({ family, weights: [400], generic: 'serif' as const, formats: { 400: 'woff2' as const }, source: 'uploaded' as const });
const faces = () => document.getElementById('self-hosted-fonts')?.textContent || '';

describe('font loader', () => {
  beforeEach(() => { forgetFontsList(); vi.mocked(fontsService.list).mockReset(); });
  afterEach(() => vi.useRealTimers());

  it('after the font list is forgotten (an upload in this tab), a new family is loaded', async () => {
    vi.mocked(fontsService.list).mockResolvedValueOnce([]);
    await loadFontForFamily("'Studio Serif', serif");
    expect(faces()).not.toContain('Studio Serif');
    vi.mocked(fontsService.list).mockResolvedValueOnce([font('Studio Serif')]);
    forgetFontsList();
    await loadFontForFamily("'Studio Serif', serif");
    expect(faces()).toContain("font-family:'Studio Serif'");
  });

  it('a family the cached list does not know is looked up again (an upload in another tab), not more than every few seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.mocked(fontsService.list).mockResolvedValue([]);
    await loadFontForFamily("'Other Serif', serif");
    await loadFontForFamily("'Other Serif', serif");
    expect(fontsService.list).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 30_000);
    vi.mocked(fontsService.list).mockResolvedValue([font('Other Serif')]);
    await loadFontForFamily("'Other Serif', serif");
    expect(fontsService.list).toHaveBeenCalledTimes(2);
    expect(faces()).toContain("font-family:'Other Serif'");
  });

  it('a new weight of a family already in use is added after the list is forgotten', async () => {
    vi.mocked(fontsService.list).mockResolvedValueOnce([font('Third Serif')]);
    await loadFontForFamily("'Third Serif', serif");
    vi.mocked(fontsService.list).mockResolvedValueOnce([{ ...font('Third Serif'), weights: [400, 700], formats: { 400: 'woff2' as const, 700: 'woff2' as const } }]);
    forgetFontsList();
    await loadFontForFamily("'Third Serif', serif");
    expect(faces()).toContain('font-weight:700');
  });

  it('a weight replaced in another format (or removed) changes its @font-face instead of leaving the old file', async () => {
    vi.mocked(fontsService.list).mockResolvedValueOnce([{ ...font('Fourth Serif'), weights: [400, 700], formats: { 400: 'woff2' as const, 700: 'woff2' as const } }]);
    await loadFontForFamily("'Fourth Serif', serif");
    expect(faces()).toContain('/fonts/Fourth-Serif/400.woff2');
    vi.mocked(fontsService.list).mockResolvedValueOnce([{ ...font('Fourth Serif'), weights: [400], formats: { 400: 'ttf' as const } }]);
    forgetFontsList();
    await loadFontForFamily("'Fourth Serif', serif");
    expect(faces()).toContain("/fonts/Fourth-Serif/400.ttf') format('truetype')");
    expect(faces()).not.toContain('/fonts/Fourth-Serif/400.woff2');
    expect(faces()).not.toContain('/fonts/Fourth-Serif/700.woff2');
    expect(faces().match(/font-family:'Fourth Serif'/g)).toHaveLength(1);
    // Deleted altogether: its face goes too.
    vi.mocked(fontsService.list).mockResolvedValueOnce([]);
    forgetFontsList();
    await loadFontForFamily("'Fourth Serif', serif");
    expect(faces()).not.toContain('Fourth Serif');
  });

  it('a family in use is compared with the list again once the list is old', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.mocked(fontsService.list).mockResolvedValueOnce([font('Fifth Serif')]);
    await loadFontForFamily("'Fifth Serif', serif");
    vi.setSystemTime(Date.now() + 6 * 60 * 1000);
    vi.mocked(fontsService.list).mockResolvedValueOnce([{ ...font('Fifth Serif'), formats: { 400: 'woff' as const } }]);
    await loadFontForFamily("'Fifth Serif', serif");
    expect(faces()).toContain('/fonts/Fifth-Serif/400.woff');
    expect(faces()).not.toContain('/fonts/Fifth-Serif/400.woff2');
  });
});
