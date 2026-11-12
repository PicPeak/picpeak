import { describe, expect, it } from 'vitest';
import { columnsForWidth, premiumColumns, premiumGap } from '../premiumGeometry';
import { heroImageUrl } from '../../heroImage';

describe('premiumGeometry', () => {
  it('falls back to 1, 2, 3 columns and 16 px', () => {
    expect(premiumColumns()).toEqual({ mobile: 1, tablet: 2, desktop: 3 });
    expect(premiumGap()).toBe(16);
    expect(premiumGap({ premiumGap: null as unknown as number })).toBe(16);
  });

  it('clamps stored values, which arrive as sent', () => {
    expect(premiumColumns({ premiumColumns: { mobile: 9, tablet: 0, desktop: '4' as unknown as number } }))
      .toEqual({ mobile: 3, tablet: 1, desktop: 4 });
    expect(premiumColumns({ premiumColumns: { mobile: 'x' as unknown as number, tablet: 2.6, desktop: 12 } }))
      .toEqual({ mobile: 1, tablet: 3, desktop: 6 });
    expect(premiumGap({ premiumGap: 0 })).toBe(0);
    expect(premiumGap({ premiumGap: 99 })).toBe(32);
    expect(premiumGap({ premiumGap: -4 })).toBe(0);
  });

  it('picks the columns by the album\'s width', () => {
    const columns = columnsForWidth({ mobile: 2, tablet: 3, desktop: 4 });
    expect([columns(639), columns(640), columns(1023), columns(1024)]).toEqual([2, 3, 3, 4]);
  });
});

describe('heroImageUrl', () => {
  const photo = { url: '/photo/1', hero_url: '/hero/1', slideshow_url: '/preview/1' };
  it('takes the 16:9 hero for a crop and the uncropped preview for the whole photo', () => {
    expect(heroImageUrl(photo, false)).toBe('/hero/1');
    expect(heroImageUrl(photo, true)).toBe('/preview/1');
  });
  it('falls back to the original', () => {
    expect(heroImageUrl({ url: '/photo/1' }, false)).toBe('/photo/1');
    expect(heroImageUrl({ url: '/photo/1', slideshow_url: null }, true)).toBe('/photo/1');
  });
});
