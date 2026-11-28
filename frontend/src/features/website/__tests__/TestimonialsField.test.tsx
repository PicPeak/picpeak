/**
 * An unfinished testimonial stays in the draft (issue 2618); the editor says
 * that the page leaves it out until it has a quote.
 */
import React from 'react';
import { expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TestimonialsBlock } from '../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : k), i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('../../../contexts/FeatureFlagsContext', () => ({ useFeatureFlags: () => ({ flags: {} }) }));
vi.mock('../../../services/website.service', () => ({ websiteService: {}, mediaKey: () => '' }));

import { BlockEditor } from '../BlockEditor';

it('marks a testimonial without a quote as not shown', () => {
  const block: TestimonialsBlock = {
    id: 't', type: 'testimonials', variant: 'cards', background: 'default', heading: '',
    items: [{ quote: '', author: 'Lea', role: '', image: null }, { quote: 'Lovely', author: 'Ben', role: '', image: null }],
  };
  render(<QueryClientProvider client={new QueryClient()}><BlockEditor block={block} onChange={() => {}} /></QueryClientProvider>);
  expect(screen.getAllByText('Incomplete: without a quote this testimonial is not shown on the page.')).toHaveLength(1);
});
