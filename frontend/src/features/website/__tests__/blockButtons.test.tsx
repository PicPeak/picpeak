/**
 * A block's button (hero, image and text, pricing) leads where a menu item
 * or a call-to-action button can: chosen from the pages and blocks of the
 * site, not typed as an address. The photo strip's profile link stays an
 * address, with a hint of its own.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Block, WebsiteDocument } from '../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : k), i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('../../../contexts/FeatureFlagsContext', () => ({ useFeatureFlags: () => ({ flags: {} }) }));
vi.mock('../../../hooks/usePermission', () => ({ usePermission: () => true }));
vi.mock('../../../services/website.service', () => ({ websiteService: { listPackages: () => Promise.resolve({ available: true, packages: [] }) }, mediaKey: () => '' }));

import { BlockEditor } from '../BlockEditor';
import { WebsiteDocContext } from '../LinkTargetField';

const base = { variant: 'x', background: 'default' as const };
const blocks: Block[] = [
  { ...base, id: 'h', type: 'hero', variant: 'minimal', heading: 'Hi', subheading: '', buttonLabel: 'Go', buttonTarget: null, image: null, video: null },
  { ...base, id: 'i', type: 'imageText', variant: 'image-left', heading: '', body: '', image: null, buttonLabel: 'Go', buttonTarget: null },
  { ...base, id: 'p', type: 'pricing', variant: 'cards', heading: '', intro: '', packageIds: [], showPrices: true, buttonLabel: 'Go', buttonTarget: null },
];
const doc = { pages: [{ id: 'home', title: 'Home', slug: 'home', isHome: true, blocks: [] }, { id: 'about', title: 'About', slug: 'about', blocks: [] }] } as unknown as WebsiteDocument;

const renderEditor = (block: Block, onChange = vi.fn()) => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <WebsiteDocContext.Provider value={doc}><BlockEditor block={block} onChange={onChange} /></WebsiteDocContext.Provider>
    </QueryClientProvider>,
  );
  return onChange;
};

describe('block buttons', () => {
  it.each(blocks.map((b) => [b.type, b] as const))('the %s button is chosen from the site', (_type, block) => {
    const onChange = renderEditor(block);
    fireEvent.change(screen.getByLabelText('Button link'), { target: { value: 'page' } });
    expect(onChange.mock.calls.at(-1)?.[0].buttonTarget).toEqual({ kind: 'page', pageId: 'home' });
  });

  it('the photo strip keeps an address for its profile, and says what it is for', () => {
    renderEditor({ ...base, id: 's', type: 'instagram', variant: 'strip', heading: '', handle: 'studio', profileUrl: '', images: [] });
    expect((screen.getByLabelText('Profile link') as HTMLInputElement).tagName).toBe('INPUT');
    expect(screen.getByText('The address of your profile, which the block links to.')).toBeInTheDocument();
  });
});
