/**
 * Photo source → Selection for guests (issue 2356): the subfolder applies at
 * once and the counts follow; the full link appears once there is a
 * selection, and can be copied, rotated and removed.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const api = vi.hoisted(() => ({
  getSelection: vi.fn(), setSelection: vi.fn(), createFullLink: vi.fn(), removeFullLink: vi.fn(),
}));
vi.mock('../../../../../services/events.service', () => ({ eventsService: api }));
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../../../../../components/common', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useConfirm: () => confirm,
}));

import { SelectionPanel } from '../SelectionPanel';
import type { Event } from '../../../../../types';

const event = { id: 7, slug: 'party', source_mode: 'reference', external_path: 'shoot' } as unknown as Event;
const state = (patch = {}) => ({
  available: true, selection_path: null, in_selection: 5, outside_selection: 0, full_link_url: null, ...patch,
});

function renderPanel(canEdit = true) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <SelectionPanel event={event} canEdit={canEdit} />
    </QueryClientProvider>,
  );
}

describe('SelectionPanel', () => {
  beforeEach(() => {
    Object.values(api).forEach((fn) => fn.mockReset());
    confirm.mockClear();
  });

  it('renders nothing for a gallery without an external source', async () => {
    api.getSelection.mockResolvedValue(state({ available: false }));
    const { container } = renderPanel();
    await waitFor(() => expect(api.getSelection).toHaveBeenCalledWith(7));
    expect(container).toBeEmptyDOMElement();
  });

  it('applies a subfolder and shows the counts and the full link action', async () => {
    api.getSelection.mockResolvedValue(state());
    api.setSelection.mockResolvedValue(state({ selection_path: 'gallery', in_selection: 2, outside_selection: 3 }));
    renderPanel();
    const input = await screen.findByLabelText('Selection subfolder');
    expect(screen.queryByRole('button', { name: /Create full link/ })).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: ' gallery ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(api.setSelection).toHaveBeenCalledWith(7, 'gallery'));
    expect(await screen.findByRole('status')).toHaveTextContent('2 photos in the selection, 3 only in the full view');
    expect(screen.getByRole('button', { name: /Create full link/ })).toBeInTheDocument();
  });

  it('clears the selection with an empty folder', async () => {
    api.getSelection.mockResolvedValue(state({ selection_path: 'gallery' }));
    api.setSelection.mockResolvedValue(state());
    renderPanel();
    fireEvent.change(await screen.findByLabelText('Selection subfolder'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(api.setSelection).toHaveBeenCalledWith(7, null));
  });

  it('creates, rotates after confirming, and removes the full link', async () => {
    const url = `https://photos.example/gallery/party/full/${'a'.repeat(64)}`;
    api.getSelection.mockResolvedValue(state({ selection_path: 'gallery' }));
    api.createFullLink.mockResolvedValue(state({ selection_path: 'gallery', full_link_url: url }));
    api.removeFullLink.mockResolvedValue(state({ selection_path: 'gallery' }));
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /Create full link/ }));
    expect(await screen.findByDisplayValue(url)).toBeInTheDocument();
    expect(confirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /New link/ }));
    await waitFor(() => expect(api.createFullLink).toHaveBeenCalledTimes(2));
    expect(confirm).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /Remove/ }));
    await waitFor(() => expect(api.removeFullLink).toHaveBeenCalledWith(7));
    expect(screen.queryByDisplayValue(url)).not.toBeInTheDocument();
  });

  it('shows the link but no actions to an admin who may not edit', async () => {
    api.getSelection.mockResolvedValue(state({ selection_path: 'gallery', full_link_url: 'https://x/gallery/party/full/b' }));
    renderPanel(false);
    expect(await screen.findByDisplayValue('https://x/gallery/party/full/b')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New link|Remove|Apply/ })).not.toBeInTheDocument();
  });
});
