/**
 * "Select all" in the PicTransfer photo picker.
 *
 * Picking a whole event's originals meant clicking every thumbnail. Select
 * all / deselect all now act on the open event's photos only: picks made in
 * other events stay, and photos already in the transfer are never added.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (k: string, d?: unknown, o?: Record<string, unknown>) => {
      const opts = (typeof d === 'object' && d ? d : o || {}) as Record<string, unknown>;
      const text = typeof d === 'string' ? d : (opts.defaultValue as string | undefined) ?? k;
      return text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(opts[name]));
    },
  }),
}));
vi.mock('../../../contexts/AdminAuthContext', () => ({
  useAdminAuth: () => ({ user: { id: 1, roleName: 'super_admin' } }),
}));
vi.mock('../AdminAuthenticatedImage', () => ({
  AdminAuthenticatedImage: ({ alt }: { alt: string }) => <span>{alt}</span>,
}));
vi.mock('../../../services/events.service', () => ({
  eventsService: { getEvents: vi.fn() },
}));
vi.mock('../../../services/photos.service', () => ({
  photosService: { getEventPhotos: vi.fn() },
}));

import { eventsService } from '../../../services/events.service';
import { photosService } from '../../../services/photos.service';
import { TransferPhotoPicker, type PickedPhoto } from '../TransferPhotoPicker';

const photosOf = (eventId: number, count: number) => Array.from({ length: count }, (_, i) => ({
  id: eventId * 100 + i, filename: `e${eventId}-${i}.jpg`, thumbnail_url: `/t/${eventId}/${i}`,
}));

function renderPicker(excludePhotoIds: number[] = []) {
  const onConfirm = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TransferPhotoPicker onClose={() => {}} onConfirm={onConfirm} excludePhotoIds={excludePhotoIds} />
    </QueryClientProvider>,
  );
  return onConfirm;
}

const openEvent = async (name: string) => fireEvent.click(await screen.findByRole('button', { name }));
const confirmed = (onConfirm: ReturnType<typeof vi.fn>) => {
  fireEvent.click(screen.getByRole('button', { name: 'Add selected' }));
  return (onConfirm.mock.calls.at(-1)?.[0] as PickedPhoto[]).map((p) => p.id).sort((a, b) => a - b);
};

describe('TransferPhotoPicker: select all', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(eventsService.getEvents).mockResolvedValue({
      events: [{ id: 1, event_name: 'Wedding' }, { id: 2, event_name: 'Portraits' }],
    } as never);
    vi.mocked(photosService.getEventPhotos).mockImplementation(async (id: number) => photosOf(id, id === 1 ? 3 : 2) as never);
  });

  it('selects every photo of the open event and keeps picks from other events', async () => {
    const onConfirm = renderPicker();
    await openEvent('Portraits');
    fireEvent.click(await screen.findByText('e2-0.jpg'));

    await openEvent('Wedding');
    expect(await screen.findByText('0 of 3 in this event selected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Select all (3)' }));

    expect(screen.getByText('3 of 3 in this event selected')).toBeInTheDocument();
    expect(screen.getByText('4 selected')).toBeInTheDocument();
    expect(confirmed(onConfirm)).toEqual([100, 101, 102, 200]);
    // Each pick carries the event it came from.
    expect((onConfirm.mock.calls[0][0] as PickedPhoto[]).find((p) => p.id === 100)).toMatchObject({ event_id: 1, event_name: 'Wedding' });
  });

  it('deselects only the open event\'s photos', async () => {
    const onConfirm = renderPicker();
    await openEvent('Portraits');
    fireEvent.click(await screen.findByRole('button', { name: 'Select all (2)' }));

    await openEvent('Wedding');
    fireEvent.click(await screen.findByRole('button', { name: 'Select all (3)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Deselect all' }));

    expect(screen.getByText('0 of 3 in this event selected')).toBeInTheDocument();
    expect(confirmed(onConfirm)).toEqual([200, 201]);
  });

  it('fills a partly picked event without duplicates and skips photos already in the transfer', async () => {
    const onConfirm = renderPicker([101]);
    await openEvent('Wedding');
    fireEvent.click(await screen.findByText('e1-0.jpg'));

    expect(screen.getByText('1 of 2 in this event selected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Select all (2)' }));
    expect(confirmed(onConfirm)).toEqual([100, 102]);
    expect(screen.getByRole('button', { name: 'Deselect all' })).toBeInTheDocument();
  });
});
