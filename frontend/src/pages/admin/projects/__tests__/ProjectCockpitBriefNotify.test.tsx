/**
 * The brief's "Notify customer" on the project page (issue 2678): the update
 * carries the project's own data, so unsaved project edits block it as much
 * as unsaved brief edits do.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, vi, it, expect } from 'vitest';
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
const calls = vi.hoisted(() => ({
  update: vi.fn(), save: vi.fn(), notify: vi.fn(), overview: vi.fn(), get: vi.fn(),
  permissions: ['events.view', 'events.edit'],
}));
const overview = (customerAccountId: number | null, updatedAt = '2026-08-01T00:00:00Z') => ({
  project: {
    id: 1, name: 'Hochzeit Müller', customerAccountId, customerEmail: customerAccountId ? 'kunde@example.com' : null, status: 'active',
    location: 'Castle Hill', createdAt: '2026-07-01T00:00:00Z', updatedAt,
  },
  events: [], quotes: [], contracts: [], invoices: [], emails: [],
  hours: { entries: [], totalMinutes: 0 }, valuation: { byCurrency: [] },
});
vi.mock('../../../../services/projects.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  projectsService: {
    overview: calls.overview,
    update: calls.update,
  },
}));
vi.mock('../../../../services/briefs.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  briefsService: {
    get: calls.get,
    save: calls.save, notify: calls.notify,
  },
}));
vi.mock('../../../../services/eventTypes.service', () => ({
  eventTypesService: {
    getActiveEventTypes: vi.fn(async () => [{ id: 2, name: 'Birthday', slug_prefix: 'birthday' }]),
    getEventTypes: vi.fn(async () => []),
  },
}));
vi.mock('../../../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ flags: { projects: true } }),
}));
vi.mock('../../../../contexts/PermissionsContext', () => ({
  usePermissions: () => ({ isSuperAdmin: false, hasPermission: (p: string) => calls.permissions.includes(p) }),
}));

import { ProjectCockpitPage } from '../ProjectCockpitPage';

const pending = [{ fieldId: 1, label: "Bride's name", labels: {}, change: 'changed' as const }];
let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  calls.permissions = ['events.view', 'events.edit'];
  calls.overview.mockReset().mockResolvedValue(overview(1));
  calls.get.mockReset().mockResolvedValue(projectBrief({ pendingChanges: pending }));
});

const mount = () => render(
    <QueryClientProvider client={client}>
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

it('keeps a new occasion unsaved when the brief edits for the old one fail to save', async () => {
  calls.save.mockReset().mockRejectedValue(new Error('refused'));
  calls.update.mockReset().mockResolvedValue({});
  mount();
  fireEvent.change(await screen.findByLabelText("Bride's name"), { target: { value: 'Anna Maria' } });
  await screen.findByRole('option', { name: 'Birthday' });
  fireEvent.change(screen.getByLabelText('Occasion'), { target: { value: 'birthday' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(calls.save).toHaveBeenCalledTimes(1));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls.update).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Bride's name")).toHaveValue('Anna Maria');
  expect(screen.getByLabelText('Occasion')).toHaveValue('birthday');
});

it('still saves other project data when only the brief fails', async () => {
  calls.save.mockReset().mockRejectedValue(new Error('refused'));
  calls.update.mockReset().mockResolvedValue({});
  mount();
  fireEvent.change(await screen.findByLabelText("Bride's name"), { target: { value: 'Anna Maria' } });
  fireEvent.change(screen.getByDisplayValue('Castle Hill'), { target: { value: 'Lake House' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(calls.update).toHaveBeenCalledWith(1, { location: 'Lake House' }));
});

it('reloads the brief when the project gains a customer through any path, e.g. attaching a quote', async () => {
  calls.overview.mockResolvedValue(overview(null));
  calls.get.mockResolvedValue(projectBrief({ hasCustomer: false, pendingChanges: pending }));
  mount();
  expect(await screen.findByText('Link a customer to the project to send updates.')).toBeInTheDocument();
  // What AttachDocumentDialog does after attaching a quote of a customer
  // (adopting the customer moves the project's updated_at).
  calls.overview.mockResolvedValue(overview(1, '2026-08-02T09:00:00Z'));
  calls.get.mockResolvedValue(projectBrief({ pendingChanges: pending }));
  await act(async () => { await client.invalidateQueries({ queryKey: ['project-overview', 1] }); });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Notify customer' })).toBeEnabled());
});

it('refreshes the project\'s emails after Notify', async () => {
  calls.notify.mockResolvedValue({ notifiedAt: '2027-01-01T10:00:00Z', changes: 1, mail: 'queued' });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Notify customer' }));
  await waitFor(() => expect(calls.notify).toHaveBeenCalled());
  await waitFor(() => expect(calls.overview.mock.calls.length).toBeGreaterThan(1));
});

it('reloads the brief for an editor who may not see customers, whose overview carries no customer', async () => {
  calls.permissions = ['events.view', 'events.edit'];
  // adminProjects strips the customer for a caller without customers.view.
  const redacted = (updatedAt: string) => {
    const o = overview(null, updatedAt);
    delete (o.project as Partial<typeof o.project>).customerAccountId;
    delete (o.project as Partial<typeof o.project>).customerEmail;
    return o;
  };
  calls.overview.mockResolvedValue(redacted('2026-08-01T00:00:00Z'));
  calls.get.mockResolvedValue(projectBrief({ hasCustomer: false, pendingChanges: pending }));
  mount();
  expect(await screen.findByText('Link a customer to the project to send updates.')).toBeInTheDocument();
  // Attaching a customer's gallery gave the project a customer.
  calls.overview.mockResolvedValue(redacted('2026-08-02T09:00:00Z'));
  calls.get.mockResolvedValue(projectBrief({ pendingChanges: pending }));
  await act(async () => { await client.invalidateQueries({ queryKey: ['project-overview', 1] }); });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Notify customer' })).toBeEnabled());
});
