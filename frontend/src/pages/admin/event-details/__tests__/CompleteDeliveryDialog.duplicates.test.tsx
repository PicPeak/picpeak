/**
 * Completing a delivery can remove the first-look duplicates through the
 * photo delete. Since the photo trash (issue 1733) that delete can succeed in
 * part and answers 200 with the ids it could not move in `failed`: the dialog
 * must say so, as it does when the request fails outright.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { CompleteDeliveryDialog } from '../CompleteDeliveryDialog';
import type { Event } from '../../../../types';
import type { DeliveryState } from '../../../../services/events.service';

const completeDelivery = vi.fn();
const deletePhotos = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return { ...actual, useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) };
});
vi.mock('react-toastify', () => ({
  toast: { success: (...args: unknown[]) => toastSuccess(...args), error: (...args: unknown[]) => toastError(...args) },
}));
vi.mock('../../../../services/events.service', () => ({
  eventsService: { completeDelivery: (...args: unknown[]) => completeDelivery(...args) },
}));
vi.mock('../../../../services/photos.service', () => ({
  photosService: { deletePhotos: (...args: unknown[]) => deletePhotos(...args) },
}));
vi.mock('../../../../hooks/usePermission', () => ({ usePermission: () => true }));
vi.mock('../../../../components/admin/GalleryRecipientsList', () => ({ GalleryRecipientsList: () => null }));
vi.mock('../OverviewTab', () => ({
  accountsAnnounceable: () => false,
  useAccountReach: () => ({}),
  eventNotice: () => ({ inlineEmail: null, accountNames: [], accountCount: 0, skippedAccountCount: 0 }),
}));

const completeWithDuplicates = async () => {
  const onCompleted = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CompleteDeliveryDialog
        event={{ id: 7 } as Event}
        state={{ delivered_count: 10, duplicate_count: 2 } as DeliveryState}
        isOpen
        onClose={vi.fn()}
        onCompleted={onCompleted}
      />
    </QueryClientProvider>
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole('checkbox', { name: /events\.delivery\.removeDuplicates/ }));
  await user.click(screen.getByRole('button', { name: 'events.delivery.completeAndNotify' }));
  await waitFor(() => expect(onCompleted).toHaveBeenCalled());
};

describe('CompleteDeliveryDialog: removing the first-look duplicates', () => {
  beforeEach(() => {
    [completeDelivery, deletePhotos, toastSuccess, toastError].forEach((fn) => fn.mockReset());
    completeDelivery.mockResolvedValue({ email_queued: true, duplicate_photo_ids: [21, 22] });
  });

  it('says nothing more when every duplicate was removed', async () => {
    deletePhotos.mockResolvedValue({ trashed: 2, deleted: 0, failed: [] });
    await completeWithDuplicates();
    expect(deletePhotos).toHaveBeenCalledWith(7, [21, 22]);
    expect(toastError).not.toHaveBeenCalled();
  });

  it('warns when the delete left some of them in the gallery', async () => {
    deletePhotos.mockResolvedValue({ trashed: 1, deleted: 0, failed: [22] });
    await completeWithDuplicates();
    expect(toastError).toHaveBeenCalledWith('events.delivery.duplicatesNotRemoved');
  });

  it('warns when the delete request failed', async () => {
    deletePhotos.mockRejectedValue(new Error('offline'));
    await completeWithDuplicates();
    expect(toastError).toHaveBeenCalledWith('events.delivery.duplicatesNotRemoved');
  });
});
