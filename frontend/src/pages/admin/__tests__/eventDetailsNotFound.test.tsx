/**
 * /admin/events/:id hung on the spinner forever for a nonexistent id
 * (QA 7.02). The backend returns a clean 404, but the page gated on
 * `eventLoading || !event`, so once the query settled `event` stayed
 * undefined and the condition never went false.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (k: string, fb?: unknown) => (typeof fb === 'string' ? fb : k),
      i18n: { language: 'en' },
    }),
  };
});

vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const getEvent = vi.fn();
vi.mock('../../../services/events.service', () => ({
  eventsService: {
    getEvent: (...args: unknown[]) => getEvent(...args),
    updateEvent: vi.fn(),
    deleteEvent: vi.fn(),
    extendExpiration: vi.fn(),
    duplicateEvent: vi.fn(),
    resetPassword: vi.fn(),
    publishEvent: vi.fn(),
    renameEvent: vi.fn(),
  },
}));

vi.mock('../../../hooks/usePublicSettings', () => ({
  PUBLIC_SETTINGS_QUERY_KEY: ['public-settings'],
  usePublicSettings: () => ({ data: {} }),
}));

vi.mock('../../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ flags: {}, isLoading: false }),
  useFeatureEnabled: () => false,
}));

vi.mock('../../../contexts/PermissionsContext', () => ({
  usePermissions: () => ({ hasAnyPermission: () => true, hasPermission: () => true, isLoading: false }),
}));

import { EventDetailsPage } from '../EventDetailsPage';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/admin/events/999999']}>
        <Routes>
          <Route path="/admin/events/:id" element={<EventDetailsPage />} />
          <Route path="/admin/events" element={<div>events list</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('EventDetailsPage 404 handling (QA 7.02)', () => {
  it('renders a not-found state instead of spinning forever when the event 404s', async () => {
    getEvent.mockRejectedValue({ response: { status: 404, data: { error: 'Event not found' } } });

    renderPage();

    expect(screen.getByText('events.loadingEventDetails')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('Event not found')).toBeInTheDocument();
    });
    expect(screen.queryByText('events.loadingEventDetails')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'events.backToEvents' })).toBeInTheDocument();
  });
});
