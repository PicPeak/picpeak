/**
 * A draft campaign's composer does not follow the admin to another campaign
 * (issue 1733, fork survey). newsletters/7 and newsletters/8 are the same
 * route element, so the page stays mounted across the navigation; with
 * campaign 8 already in the query cache nothing unmounts the composer on the
 * way. Its editor keeps a source-mode buffer of its own, which then went out
 * under the next campaign's id.
 *
 * Pins: going from one draft campaign to another mounts a fresh composer.
 */
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({ t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : k), i18n: { language: 'en' } }),
  };
});

vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('../../../../contexts/PermissionsContext', () => ({
  usePermissions: () => ({ hasPermission: () => true, isLoading: false }),
}));

vi.mock('../../../../components/common', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../../../components/common');
  return { ...actual, useConfirm: () => vi.fn(async () => true) };
});

vi.mock('../../../../services/newsletters.service', () => ({
  newslettersService: {
    get: vi.fn(async (id: number) => ({ campaign: { id, status: 'draft' }, recipientSummary: {} })),
    recipients: vi.fn(async () => ({ recipients: [], total: 0 })),
  },
}));

// Stands in for the composer's own state (the editor's source buffer).
vi.mock('../NewsletterComposerPage', () => ({
  NewsletterComposerPage: ({ campaignId }: { campaignId: number }) => {
    const [buffer, setBuffer] = useState('');
    return <textarea aria-label={`Body of ${campaignId}`} value={buffer} onChange={(e) => setBuffer(e.target.value)} />;
  },
}));

import { NewsletterDetailPage } from '../NewsletterDetailPage';

it('mounts a fresh composer for another draft campaign', async () => {
  const user = userEvent.setup();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['newsletter', 8], { campaign: { id: 8, status: 'draft' }, recipientSummary: {} });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/admin/clients/newsletters/7']}>
        <Link to="/admin/clients/newsletters/8">other campaign</Link>
        <Routes>
          <Route path="/admin/clients/newsletters/:id" element={<NewsletterDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  await user.type(await screen.findByLabelText('Body of 7'), 'edits to campaign 7');
  await user.click(screen.getByRole('link', { name: 'other campaign' }));

  expect(await screen.findByLabelText('Body of 8')).toHaveValue('');
});
