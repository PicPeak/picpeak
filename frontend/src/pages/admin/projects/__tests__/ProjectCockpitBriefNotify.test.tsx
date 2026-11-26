/**
 * The brief's "Notify customer" on the project page (issue 2678): the update
 * carries the project's own data, so unsaved project edits block it as much
 * as unsaved brief edits do.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi, it, expect } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { projectBrief } from '../../../../features/briefs/__tests__/fixtures';

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
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const calls = vi.hoisted(() => ({ update: vi.fn(), save: vi.fn() }));
vi.mock('../../../../services/projects.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  projectsService: {
    overview: vi.fn(async () => ({
      project: {
        id: 1, name: 'Hochzeit Müller', customerAccountId: 1, customerEmail: 'kunde@example.com', status: 'active',
        location: 'Castle Hill', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
      },
      events: [], quotes: [], contracts: [], invoices: [], emails: [],
      hours: { entries: [], totalMinutes: 0 }, valuation: { byCurrency: [] },
    })),
    update: calls.update,
  },
}));
vi.mock('../../../../services/briefs.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  briefsService: {
    get: vi.fn(async () => projectBrief({ pendingChanges: [{ fieldId: 1, label: "Bride's name", labels: {}, change: 'changed' }] })),
    save: calls.save, notify: vi.fn(),
  },
}));
vi.mock('../../../../services/eventTypes.service', () => ({
  eventTypesService: { getActiveEventTypes: vi.fn(async () => []), getEventTypes: vi.fn(async () => []) },
}));
vi.mock('../../../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ flags: { projects: true } }),
}));
vi.mock('../../../../contexts/PermissionsContext', () => ({
  usePermissions: () => ({ isSuperAdmin: false, hasPermission: (p: string) => ['events.view', 'events.edit'].includes(p) }),
}));

import { ProjectCockpitPage } from '../ProjectCockpitPage';

const mount = () => render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/admin/projects/1']}>
        <Routes><Route path="/admin/projects/:id" element={<ProjectCockpitPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
);

it('keeps Notify off while the project data has unsaved edits', async () => {
  mount();
  const notify = await screen.findByRole('button', { name: 'Notify customer' });
  expect(notify).toBeEnabled();
  fireEvent.change(screen.getByDisplayValue('Castle Hill'), { target: { value: 'Lake House' } });
  expect(screen.getByRole('button', { name: 'Notify customer' })).toBeDisabled();
  expect(screen.getByText('Save your changes first.')).toBeInTheDocument();
});

it('saves the brief before the project data, so a new occasion cannot void the brief edits', async () => {
  let finish: (brief: unknown) => void = () => {};
  calls.save.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  calls.update.mockResolvedValue({});
  mount();
  fireEvent.change(await screen.findByLabelText("Bride's name"), { target: { value: 'Anna Maria' } });
  fireEvent.change(screen.getByDisplayValue('Castle Hill'), { target: { value: 'Lake House' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(calls.save).toHaveBeenCalledTimes(1));
  expect(calls.update).not.toHaveBeenCalled();
  await act(async () => { finish(projectBrief()); });
  await waitFor(() => expect(calls.update).toHaveBeenCalledWith(1, { location: 'Lake House' }));
});
