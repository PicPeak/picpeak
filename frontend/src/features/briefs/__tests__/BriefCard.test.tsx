/** The brief card on the project cockpit (issue 2678). */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { toast } from 'react-toastify';
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

const Harness: React.FC<{ canEdit?: boolean; id?: number }> = ({ canEdit = true, id = 7 }) => {
  const editor = useBriefEditor({ kind: 'projects', id });
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

  it('says when the customer takes no administrative email and only the portal was updated', async () => {
    state.notify.mockResolvedValue({ notifiedAt: '2027-01-01T10:00:00Z', changes: 1, mail: 'suppressed' });
    state.get.mockResolvedValue(projectBrief({ pendingChanges: [{ fieldId: 1, label: 'x', labels: {}, change: 'added' }] }));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Notify customer' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(
      'Portal updated. The customer takes no administrative email, so no email was sent.',
    ));
  });

  it('drops the draft when the card moves to another project', async () => {
    state.get.mockImplementation(async ({ id }: { id: number }) => (id === 7 ? projectBrief() : projectBrief({
      fields: projectBrief().fields.map((f) => (f.id === 1 ? { ...f, value: 'Clara' } : f)),
    })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = (id: number) => (
      <QueryClientProvider client={client}><MemoryRouter><Harness id={id} /></MemoryRouter></QueryClientProvider>
    );
    const { rerender } = render(tree(7));
    fireEvent.change(await screen.findByLabelText('Name der Braut'), { target: { value: 'Edited on 7' } });
    rerender(tree(8));
    await waitFor(() => expect(screen.getByLabelText('Name der Braut')).toHaveValue('Clara'));
    expect(screen.queryByText('not saved yet')).toBeNull();
    expect(screen.getByRole('button', { name: 'page save' })).toBeDisabled();
  });

  it('takes the saved brief as its baseline: a later refetch wins, an edit made during the save stays', async () => {
    const withName = (name: string) => projectBrief({ fields: projectBrief().fields.map((f) => (f.id === 1 ? { ...f, value: name } : f)) });
    let finish: (brief: unknown) => void = () => {};
    state.save.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter><Harness /></MemoryRouter></QueryClientProvider>);
    fireEvent.change(await screen.findByLabelText('Name der Braut'), { target: { value: 'Anna Maria' } });
    fireEvent.click(screen.getByRole('button', { name: 'page save' }));
    await waitFor(() => expect(state.save).toHaveBeenCalledTimes(1));
    // Typed while the request runs.
    fireEvent.change(screen.getByLabelText('Shared arrangements'), { target: { value: 'Typed meanwhile' } });
    await act(async () => { finish(withName('Anna Maria')); });
    expect(screen.getByLabelText('Shared arrangements')).toHaveValue('Typed meanwhile');

    // Another admin changes the name; the refetch brings it.
    state.get.mockResolvedValue(withName('Clara'));
    await act(async () => { await client.invalidateQueries({ queryKey: ['brief'] }); });
    await waitFor(() => expect(screen.getByLabelText('Name der Braut')).toHaveValue('Clara'));
    expect(screen.getByLabelText('Shared arrangements')).toHaveValue('Typed meanwhile');
    state.save.mockClear().mockResolvedValue(withName('Clara'));
    fireEvent.click(screen.getByRole('button', { name: 'page save' }));
    await waitFor(() => expect(state.save).toHaveBeenCalledWith({ kind: 'projects', id: 7 }, { sharedArrangements: 'Typed meanwhile' }));
  });

  it('keeps a removal made while a save runs', async () => {
    const twoRemoved = projectBrief({ fields: [...projectBrief().fields,
      { ...projectBrief().fields[4], id: 10, label: 'Old note', value: 'Note' }] });
    state.get.mockResolvedValue(twoRemoved);
    let finish: (brief: unknown) => void = () => {};
    state.save.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    mount();
    await screen.findByText('Note');
    const [removeGroom] = screen.getAllByRole('button', { name: 'Remove' });
    fireEvent.click(removeGroom);
    fireEvent.click(screen.getByRole('button', { name: 'page save' }));
    await waitFor(() => expect(state.save).toHaveBeenCalledTimes(1));
    expect(state.save).toHaveBeenLastCalledWith({ kind: 'projects', id: 7 }, { values: { 9: { value: null } } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await act(async () => { finish(projectBrief({ fields: twoRemoved.fields.filter((f) => f.id !== 9) })); });
    expect(screen.queryByText('Note')).toBeNull();
    state.save.mockClear().mockResolvedValue(projectBrief({ fields: twoRemoved.fields.filter((f) => f.id < 9) }));
    fireEvent.click(screen.getByRole('button', { name: 'page save' }));
    await waitFor(() => expect(state.save).toHaveBeenCalledWith({ kind: 'projects', id: 7 }, { values: { 10: { value: null } } }));
  });

  it('edits the title the customer sees, offering the occasion as the default', async () => {
    mount();
    const title = await screen.findByLabelText('Title the customer sees');
    expect(title).toHaveAttribute('placeholder', 'Wedding');
    fireEvent.change(title, { target: { value: 'Anna & Ben' } });
    fireEvent.click(screen.getByRole('button', { name: 'page save' }));
    await waitFor(() => expect(state.save).toHaveBeenCalledWith({ kind: 'projects', id: 7 }, { title: 'Anna & Ben' }));
  });

  it('puts a save answer that arrives after a switch to another project on its own project only', async () => {
    const withName = (name: string) => projectBrief({ fields: projectBrief().fields.map((f) => (f.id === 1 ? { ...f, value: name } : f)) });
    state.get.mockImplementation(async ({ id }: { id: number }) => (id === 7 ? projectBrief() : withName('Clara')));
    let finish: (brief: unknown) => void = () => {};
    state.save.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = (id: number) => (
      <QueryClientProvider client={client}><MemoryRouter><Harness id={id} /></MemoryRouter></QueryClientProvider>
    );
    const { rerender } = render(tree(7));
    fireEvent.change(await screen.findByLabelText('Name der Braut'), { target: { value: 'Anna Maria' } });
    fireEvent.click(screen.getByRole('button', { name: 'page save' }));
    await waitFor(() => expect(state.save).toHaveBeenCalledTimes(1));
    rerender(tree(8));
    await waitFor(() => expect(screen.getByLabelText('Name der Braut')).toHaveValue('Clara'));
    await act(async () => { finish(withName('Anna Maria')); });
    expect(screen.getByLabelText('Name der Braut')).toHaveValue('Clara');
    expect(screen.queryByText('not saved yet')).toBeNull();
    expect((client.getQueryData(['brief', 'projects', 8]) as ReturnType<typeof projectBrief>).fields[0].value).toBe('Clara');
    expect((client.getQueryData(['brief', 'projects', 7]) as ReturnType<typeof projectBrief>).fields[0].value).toBe('Anna Maria');
  });

  it('starts from the saved brief when the card comes back to a project after another one', async () => {
    const withName = (name: string) => projectBrief({ fields: projectBrief().fields.map((f) => (f.id === 1 ? { ...f, value: name } : f)) });
    state.get.mockImplementation(async ({ id }: { id: number }) => (id === 7 ? projectBrief() : withName('Clara')));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = (id: number) => (
      <QueryClientProvider client={client}><MemoryRouter><Harness id={id} /></MemoryRouter></QueryClientProvider>
    );
    const { rerender } = render(tree(7));
    fireEvent.change(await screen.findByLabelText('Name der Braut'), { target: { value: 'Discarded on leaving' } });
    rerender(tree(8));
    await waitFor(() => expect(screen.getByLabelText('Name der Braut')).toHaveValue('Clara'));
    rerender(tree(7));
    await waitFor(() => expect(screen.getByLabelText('Name der Braut')).toHaveValue('Anna'));
    expect(screen.queryByText('not saved yet')).toBeNull();
    expect(screen.getByRole('button', { name: 'page save' })).toBeDisabled();
  });

  it('gives the multi-line fields their height, not the single-line input class', async () => {
    mount();
    for (const label of ['Internal remark', 'Shared arrangements']) {
      const box = await screen.findByLabelText(label);
      expect(box.tagName).toBe('TEXTAREA');
      expect(Number(box.getAttribute('rows'))).toBeGreaterThan(1);
      // .input carries a fixed h-10 (index.css): a textarea with it shows one line.
      expect(box).not.toHaveClass('input');
    }
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
