/** Settings → Brief templates (issue 2678). */
import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const state = vi.hoisted(() => ({
  templates: vi.fn(), saveTemplate: vi.fn(), permissions: new Set<string>(), toastError: vi.fn(),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, fb?: unknown, opts?: Record<string, unknown>) =>
      (typeof fb === 'string' ? fb.replace(/\{\{(\w+)\}\}/g, (_m, key) => String(opts?.[key] ?? '')) : _k),
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: state.toastError } }));
vi.mock('../../../contexts/PermissionsContext', () => ({ usePermissions: () => ({ hasPermission: (p: string) => state.permissions.has(p) }) }));
vi.mock('../../../components/admin/SettingsSaveBar', () => ({
  SettingsSaveBar: ({ isDirty, onSave }: { isDirty: boolean; onSave: () => void }) => (
    <button type="button" disabled={!isDirty} onClick={onSave}>Save changes</button>
  ),
}));
vi.mock('../../../services/eventTypes.service', () => ({
  eventTypesService: {
    getEventTypes: vi.fn(async (includeInactive?: boolean) => [
      { id: 1, name: 'Wedding', slug_prefix: 'wedding', is_active: true },
      ...(includeInactive ? [{ id: 2, name: 'Ball', slug_prefix: 'ball', is_active: false }] : []),
      { id: 3, name: 'Global gala', slug_prefix: 'global', is_active: true },
      { id: 4, name: 'Builders', slug_prefix: 'constructor', is_active: true },
    ]),
  },
}));
vi.mock('../../../services/briefs.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  briefsService: { templates: state.templates, saveTemplate: state.saveTemplate },
}));

import { BriefTemplatesPage } from '../BriefTemplatesPage';

const saved = {
  global: [{ id: 1, label: 'Contact on the day', labels: {}, type: 'short_text', visibleDefault: true }],
  occasions: { wedding: [
    { id: 2, label: "Bride's name", labels: { de: 'Name der Braut' }, type: 'short_text', visibleDefault: true },
    { id: 3, label: 'Wedding date', labels: {}, type: 'project_date', visibleDefault: true },
  ] },
};

function mount() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <BriefTemplatesPage />
  </QueryClientProvider>);
}

beforeEach(() => {
  state.permissions = new Set(['settings.view', 'settings.edit']);
  state.templates.mockReset().mockResolvedValue(saved);
  state.saveTemplate.mockReset().mockImplementation(async (_occasion, fields) => fields.map((f: object, i: number) => ({ id: 100 + i, ...f })));
  state.toastError.mockReset();
});

it('keeps a saved field\'s type and saves each changed list in its order', async () => {
  mount();
  expect(await screen.findByDisplayValue('Contact on the day')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();

  // Global: add a field.
  fireEvent.click(screen.getByRole('button', { name: 'Add field' }));
  const labels = screen.getAllByLabelText('Label');
  fireEvent.change(labels[1], { target: { value: 'Dress code' } });
  fireEvent.change(screen.getAllByLabelText('Type')[1], { target: { value: 'yes_no' } });

  // Wedding: the saved fields keep their type; move the date to the top.
  await screen.findByRole('option', { name: 'Wedding' });
  fireEvent.change(screen.getByLabelText('Template'), { target: { value: 'wedding' } });
  expect(screen.getAllByLabelText('Type')[1]).toBeDisabled();
  fireEvent.click(screen.getAllByRole('button', { name: 'Move up' })[1]);

  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(state.saveTemplate).toHaveBeenCalledTimes(2));
  expect(state.saveTemplate).toHaveBeenCalledWith(null, [
    saved.global[0],
    { label: 'Dress code', labels: {}, type: 'yes_no', visibleDefault: true },
  ]);
  expect(state.saveTemplate).toHaveBeenCalledWith('wedding', [saved.occasions.wedding[1], saved.occasions.wedding[0]]);
});

it('takes no edits while a save is under way', async () => {
  let finish: (fields: unknown[]) => void = () => {};
  state.saveTemplate.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  mount();
  const label = await screen.findByDisplayValue('Contact on the day');
  fireEvent.change(label, { target: { value: 'Contact person' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(state.saveTemplate).toHaveBeenCalledTimes(1));
  expect(screen.getByDisplayValue('Contact person')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Add field' })).toBeDisabled();
  finish([{ ...saved.global[0], label: 'Contact person' }]);
  await waitFor(() => expect(screen.getByDisplayValue('Contact person')).toBeEnabled());
});

it('refuses a field without a label', async () => {
  mount();
  await screen.findByDisplayValue('Contact on the day');
  fireEvent.click(screen.getByRole('button', { name: 'Add field' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  expect(state.toastError).toHaveBeenCalledWith('Every field needs a label.');
  expect(state.saveTemplate).not.toHaveBeenCalled();
});

it('removes a field from the list', async () => {
  mount();
  await screen.findByDisplayValue('Contact on the day');
  fireEvent.click(screen.getByRole('button', { name: 'Remove field' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(state.saveTemplate).toHaveBeenCalledWith(null, []));
});

it('is read-only without settings.edit', async () => {
  state.permissions = new Set(['settings.view']);
  mount();
  expect(await screen.findByDisplayValue('Contact on the day')).toBeDisabled();
  expect(screen.getByText('You can see these templates but not change them.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
});

it('lists inactive occasions too, marked, since their briefs still use the template', async () => {
  mount();
  fireEvent.change(await screen.findByLabelText('Template'), { target: { value: 'ball' } });
  expect(await screen.findByRole('option', { name: 'Ball (inactive)' })).toBeInTheDocument();
  expect(screen.getByLabelText('Template')).toHaveValue('ball');
});

it('saves an occasion whose slug is "global" as that occasion, not as the shared list', async () => {
  mount();
  await screen.findByRole('option', { name: 'Global gala' });
  fireEvent.change(screen.getByLabelText('Template'), { target: { value: 'global' } });
  expect(screen.getByText('No fields yet.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Add field' }));
  fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Gala table' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(state.saveTemplate).toHaveBeenCalledWith('global', [
    { label: 'Gala table', labels: {}, type: 'short_text', visibleDefault: true },
  ]));
});

it('takes an occasion whose slug names an Object property', async () => {
  mount();
  await screen.findByRole('option', { name: 'Builders' });
  fireEvent.change(screen.getByLabelText('Template'), { target: { value: 'constructor' } });
  expect(screen.getByText('No fields yet.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Add field' }));
  fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Crane' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(state.saveTemplate).toHaveBeenCalledWith('constructor', [
    { label: 'Crane', labels: {}, type: 'short_text', visibleDefault: true },
  ]));
  expect(await screen.findByDisplayValue('Crane')).toBeInTheDocument();
});
