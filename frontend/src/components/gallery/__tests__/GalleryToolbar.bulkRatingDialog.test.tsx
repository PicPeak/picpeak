/**
 * Issue 2306: the toolbar hosts the real BulkRating, which now also reports
 * the guest registration prompt as an open dialog. The toolbar holds its
 * layout across a breakpoint change while that prompt is open, as it does for
 * the name-and-email dialog.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ submitBulkRating: vi.fn(), guestContext: null as null | Record<string, unknown> }));

vi.mock('react-i18next', async () => ({
  ...await vi.importActual('react-i18next'),
  useTranslation: () => ({
    t: (key: string, fallback?: unknown, opts?: Record<string, unknown>) =>
      (typeof fallback === 'string' ? fallback : key).replace(/\{\{(\w+)\}\}/g, (_m, k) => String(opts?.[k] ?? '')),
    i18n: { language: 'en' },
  }),
}));
vi.mock('react-toastify', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('../../../services/feedback.service', () => ({
  BULK_RATING_MAX_PHOTOS: 200,
  feedbackService: { submitBulkRating: mocks.submitBulkRating },
}));
vi.mock('../../../contexts/GuestIdentityContext', () => ({ useGuestIdentityOptional: () => mocks.guestContext }));
vi.mock('../../../utils/guestIdentityStorage', () => ({ getGuestIdentity: () => null }));
vi.mock('../DownloadQuotaNotice', () => ({ DownloadQuotaNotice: () => null }));
vi.mock('../GallerySidebarSelectionTray', () => ({ GallerySidebarSelectionTray: () => null }));

import { GalleryToolbar } from '../GalleryToolbar';

afterEach(() => vi.unstubAllGlobals());

describe('GalleryToolbar with the guest registration prompt (issue 2306)', () => {
  it('holds the desktop layout while the inline rating waits on guest registration', async () => {
    let listener: () => void = () => {};
    let phone = false;
    vi.stubGlobal('matchMedia', (query: string) => ({
      get matches() { return query === '(max-width: 639px)' && phone; },
      media: query,
      addEventListener: (_type: string, cb: () => void) => { listener = cb; },
      removeEventListener: () => {},
    }));
    let register: (value: unknown) => void = () => {};
    mocks.guestContext = {
      identityMode: 'guest',
      identity: null,
      ensureIdentity: vi.fn(() => new Promise((resolve) => { register = resolve; })),
    };
    mocks.submitBulkRating.mockResolvedValue({ success: true, rating: 4, results: [1, 2].map((id) => ({ photo_id: id, success: true })) });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <GalleryToolbar
          search={{ value: '', onChange: vi.fn() }}
          selection={{
            available: true, hasVideos: false, isSelectionMode: true, selectedCount: 2, visibleCount: 12,
            onStart: vi.fn(), onCancel: vi.fn(), onSelectAll: vi.fn(), onDeselectAll: vi.fn(),
            bulkRating: { slug: 's', photoIds: [1, 2] },
          }}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Rate 4 stars' }));
    phone = true;
    act(() => listener());
    expect(screen.getByTestId('gallery-toolbar')).toHaveAttribute('data-mode', 'selection');
    expect(screen.queryByTestId('gallery-selection-bar')).toBeNull();

    register({ id: 7, name: 'Ann' });
    await waitFor(() => expect(screen.getByTestId('gallery-selection-bar')).toBeInTheDocument());
    await waitFor(() => expect(mocks.submitBulkRating).toHaveBeenCalledWith('s', [1, 2], 4, expect.anything()));
  });
});
