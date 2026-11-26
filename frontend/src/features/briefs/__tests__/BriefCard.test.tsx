/** The brief card on the project cockpit (issue 2678). */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { projectBrief } from './fixtures';

const state = vi.hoisted(() => ({
  get: vi.fn(), save: vi.fn(), notify: vi.fn(), confirm: vi.fn(), language: 'de',
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, fb?: unknown, opts?: Record<string, unknown>) =>
      (typeof fb === 'string' ? fb.replace(/\{\{(\w+)\}\}/g, (_m, key) => String(opts?.[key] ?? '')) : _k),
    i18n: { language: state.language },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../hooks/useLocalizedDate', () => ({
  useLocalizedDate: () => ({ format: (d: string) => `day:${d}`, formatTime: (d: string) => d, formatWallClock: (d: string) => d, formatDateTime: (d: string) => `at:${d}` }),
}));
vi.mock('../../../components/common', async () => ({
  ...(await vi.importActual<object>('../../../components/common')),
  useConfirm: () => state.confirm,
}));
vi.mock('../../../services/briefs.service', () => ({
  briefsService: { get: state.get, save: state.save, notify: state.notify },
}));
vi.mock('../../../services/eventTypes.service', () => ({ eventTypesService: { getActiveEventTypes: vi.fn(async () => []) } }));

import { BriefCard, useBriefEditor } from '../BriefCard';

const Harness: React.FC<{ canEdit?: boolean }> = ({ canEdit = true }) => {
  const editor = useBriefEditor({ kind: 'projects', id: 7 });
  return (
    <>
      <BriefCard editor={editor} canEdit={canEdit} />
      <button type="button" onClick={() => editor.save.mutate()} disabled={!editor.dirty}>page save</button>
    </>
  );
};

function mount(canEdit = true) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter><Harness canEdit={canEdit} /></MemoryRouter>
  </QueryClientProvider>);
}

beforeEach(() => {
  state.language = 'de';
  state.get.mockReset().mockResolvedValue(projectBrief());
  state.save.mockReset().mockImplementation(async () => projectBrief());
  state.notify.mockReset().mockResolvedValue({ notifiedAt: '2027-01-01T10:00:00Z', changes: 2 });
  state.confirm.mockReset().mockResolvedValue(true);
});

describe('BriefCard on a project', () => {
  it('labels fields in the UI language, shows project data read-only and keeps removed values apart', async () => {
    mount();
    expect(await screen.findByLabelText('Name der Braut')).toHaveValue('Anna');
    expect(screen.getByText('day:2027-06-12')).toBeInTheDocument();
    expect(screen.getByText('From the project data')).toBeInTheDocument();
    expect(screen.getByText('No longer in the template')).toBeInTheDocument();
    expect(screen.getByText('Ben')).toBeInTheDocument();
    expect(screen.queryByLabelText("Groom's name")).toBeNull();
  });

  it('sends only what changed: a value, a visibility choice and a cleared removed field', async () => {
    mount();
    fireEvent.change(await screen.findByLabelText('Name der Braut'), { target: { value: 'Anna Maria' } });
    // The hidden-by-default remark is switched on; the date is switched off.
    const toggles = screen.getAllByRole('button', { pressed: true });
    fireEvent.click(toggles.find((b) => b.closest('div')?.textContent?.includes('Wedding date'))!);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByText('not saved yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'page save' }));
    await waitFor(() => expect(state.save).toHaveBeenCalledTimes(1));
    expect(state.save).toHaveBeenCalledWith({ kind: 'projects', id: 7 }, {
      values: { 1: { value: 'Anna Maria' }, 2: { visible: false }, 9: { value: null } },
    });
  });

  it('turning a field back to its template choice follows the template again', async () => {
    state.get.mockResolvedValue(projectBrief({
      fields: projectBrief().fields.map((f) => (f.id === 4 ? { ...f, visible: true } : f)),
    }));
    mount();
    await screen.findByLabelText('Name der Braut');
    const remark = screen.getAllByRole('button', { pressed: true }).find((b) => b.closest('div')?.textContent?.includes('Internal remark'))!;
    fireEvent.click(remark);
    fireEvent.click(screen.getByRole('button', { name: 'page save' }));
    await waitFor(() => expect(state.save).toHaveBeenCalledWith({ kind: 'projects', id: 7 }, { values: { 4: { visible: null } } }));
  });

  it('keeps Notify off without unsent changes', async () => {
    mount();
    const button = await screen.findByRole('button', { name: 'Notify customer' });
    expect(button).toBeDisabled();
    expect(screen.getByText('The customer has the current state.')).toBeInTheDocument();
  });

  it('sends the update after the confirmation', async () => {
    state.get.mockResolvedValue(projectBrief({
      notifiedAt: '2026-12-01T08:00:00Z',
      pendingChanges: [{ fieldId: 1, label: "Bride's name", labels: {}, change: 'changed' }, { fieldId: null, label: null, labels: {}, change: 'added' }],
    }));
    mount();
    expect(await screen.findByText('Changes not sent yet: 2')).toBeInTheDocument();
    expect(screen.getByText('Last update sent at:2026-12-01T08:00:00Z')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Name der Braut'), { target: { value: 'X' } });
    expect(screen.getByRole('button', { name: 'Notify customer' })).toBeDisabled();
    expect(screen.getByText('Save your changes first.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Name der Braut'), { target: { value: 'Anna' } });
    fireEvent.click(screen.getByRole('button', { name: 'Notify customer' }));
    await waitFor(() => expect(state.notify).toHaveBeenCalledWith({ kind: 'projects', id: 7 }));
    expect(state.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('(2)') }));
  });

  it('says why a project without a customer cannot notify', async () => {
    state.get.mockResolvedValue(projectBrief({ hasCustomer: false, pendingChanges: [{ fieldId: 1, label: 'x', labels: {}, change: 'added' }] }));
    mount();
    expect(await screen.findByText('Link a customer to the project to send updates.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Notify customer' })).toBeDisabled();
  });

  it('is read-only without the edit permission', async () => {
    mount(false);
    expect(await screen.findByText('You can see this brief but not change it.')).toBeInTheDocument();
    expect(screen.getByLabelText('Name der Braut')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Notify customer' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });
});
