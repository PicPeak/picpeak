import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { BLOCK_TYPES, BLOCK_VARIANTS, collectImageRefs, createBlock, moveItem, slugWhileTyping } from '../blocks';
import { isSafeUrl } from '../fields';
import { RESERVED_SLUGS, slugProblem } from '../PagesPanel';
import type { WebsiteDocument } from '../types';

const t = ((key: string, fallback?: string) => fallback ?? key) as unknown as TFunction;

describe('website builder blocks', () => {
  it('creates every block type with its default variant and a fresh id', () => {
    const ids = new Set<string>();
    for (const type of BLOCK_TYPES) {
      const block = createBlock(type, t);
      expect(block.type).toBe(type);
      expect(block.background).toBe('default');
      expect(BLOCK_VARIANTS[type]).toContain(block.variant);
      expect(block.id).toMatch(/^[0-9a-f]{12}$/);
      ids.add(block.id);
    }
    expect(ids.size).toBe(BLOCK_TYPES.length);
  });

  it('moves an item and ignores moves out of range', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    const list = ['a', 'b'];
    expect(moveItem(list, 0, 5)).toBe(list);
    expect(moveItem(list, -1, 0)).toBe(list);
  });

  it('cleans a slug while it is typed, keeping a hyphen at the end', () => {
    expect(slugWhileTyping('Über Uns')).toBe('uber-uns');
    expect(slugWhileTyping('about-')).toBe('about-');
    expect(slugWhileTyping('../../etc')).toBe('etc');
    expect(slugWhileTyping('a//b')).toBe('a-b');
  });

  it('reports reserved and duplicate addresses before the server does', () => {
    const doc = {
      pages: [
        { id: 'a', slug: 'about', isHome: false },
        { id: 'b', slug: 'about', isHome: false },
        { id: 'c', slug: 'admin', isHome: false },
        { id: 'd', slug: '', isHome: false },
      ],
    } as unknown as WebsiteDocument;
    expect(slugProblem(doc, doc.pages[0])).toBe('duplicate');
    expect(slugProblem(doc, doc.pages[2])).toBe('reserved');
    expect(slugProblem(doc, doc.pages[3])).toBe('empty');
    expect(RESERVED_SLUGS.has('site-media')).toBe(true);
  });

  it('collects every image of a document for the thumbnail lookup', () => {
    const doc = {
      pages: [{
        seo: { image: { source: 'photo', id: 1 } },
        blocks: [
          { type: 'hero', image: { source: 'asset', id: 'a'.repeat(24) }, video: { source: 'asset', id: 'b'.repeat(24) } },
          { type: 'gallery', images: [{ source: 'photo', id: 2 }] },
          { type: 'testimonials', items: [{ image: { source: 'photo', id: 3 } }, { image: null }] },
          { type: 'text' },
        ],
      }],
    } as unknown as WebsiteDocument;
    expect(collectImageRefs(doc).map((r) => `${r.source}:${r.id}`)).toEqual([
      'photo:1', `asset:${'a'.repeat(24)}`, `asset:${'b'.repeat(24)}`, 'photo:2', 'photo:3',
    ]);
  });
});

describe('link check', () => {
  it.each(['', '/about', '#contact', 'https://example.com', 'mailto:a@b.c', 'tel:+41 44 000 00 00'])('accepts %s', (url) => {
    expect(isSafeUrl(url)).toBe(true);
  });
  it.each(['javascript:alert(1)', '//evil.example', 'data:text/html,x', 'ftp://x', 'https://', '#a b'])('refuses %s', (url) => {
    expect(isSafeUrl(url)).toBe(false);
  });
});
