/**
 * The event code card (issue 2495): shows the grouped code, saves a chosen
 * code (409 = taken, said in the field), removes a code, stays away from an
 * admin who may not hand out the gallery's links, and only says that codes
 * are off while the setting is off. The print buttons download the /code
 * table card and poster only while there is a code.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { toast } from 'react-toastify';
import { EventCodeCard } from '../EventCodeCard';
import type { Event } from '../../../../types';

const service = vi.hoisted(() => ({
  regenerateAccessCode: vi.fn(), setAccessCode: vi.fn(), removeAccessCode: vi.fn(), getQrPrintBlob: vi.fn(),
}));
const perms = vi.hoisted(() => ({ edit: true }));
const publicSettings = vi.hoisted(() => ({ enabled: true }));
const confirmMock = vi.hoisted(() => vi.fn());
// A real query, so invalidating the public settings refetches them.
vi.mock('../../../../hooks/usePublicSettings', async () => {
  const { useQuery } = await import('@tanstack/react-query');
  const PUBLIC_SETTINGS_QUERY_KEY = ['public-settings'] as const;
  return {
    PUBLIC_SETTINGS_QUERY_KEY,
    usePublicSettings: () => useQuery({
      queryKey: PUBLIC_SETTINGS_QUERY_KEY,
      queryFn: async () => ({ general_event_codes_enabled: publicSettings.enabled }),
      staleTime: Infinity,
    }),
  };
});
vi.mock('../../../../components/common/ConfirmDialog', () => ({ useConfirm: () => confirmMock }));
vi.mock('../../../../services/events.service', () => ({ eventsService: service }));
vi.mock('../../../../hooks/usePermission', () => ({ usePermission: () => perms.edit }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'de-CH' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const baseEvent = { id: 9, slug: 'wedding', require_password: true, is_archived: false, access_code: 'K7M4QX' } as unknown as Event;
const renderCard = (over: Partial<Event> = {}) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(['public-settings'], { general_event_codes_enabled: publicSettings.enabled });
  return render(
    <QueryClientProvider client={queryClient}>
      <EventCodeCard event={{ ...baseEvent, ...over } as Event} />
    </QueryClientProvider>,
  );
};

describe('EventCodeCard', () => {
  beforeEach(() => {
    service.regenerateAccessCode.mockReset();
    service.setAccessCode.mockReset();
    service.removeAccessCode.mockReset();
    service.getQrPrintBlob.mockReset();
    confirmMock.mockReset();
    vi.mocked(toast.error).mockClear();
    perms.edit = true;
    publicSettings.enabled = true;
  });

  it('only says that codes are off while the setting is off', () => {
    publicSettings.enabled = false;
    renderCard();
    expect(screen.getByTestId('event-code-disabled')).toHaveTextContent('events.eventCode.disabled');
    expect(screen.queryByTestId('event-code-value')).toBeNull();
    expect(screen.queryByText('events.eventCode.regenerate')).toBeNull();
    expect(screen.queryByText('events.eventCode.remove')).toBeNull();
    expect(screen.queryByTestId('event-code-print')).toBeNull();
  });

  it('downloads the /code table card and poster with the code variant', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:print');
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    service.getQrPrintBlob.mockResolvedValue(new Blob(['%PDF']));
    perms.edit = false; // printing needs no edit permission
    renderCard();
    fireEvent.click(screen.getByText('events.qrTableCard'));
    await vi.waitFor(() => expect(service.getQrPrintBlob).toHaveBeenCalledWith(9, 'table-card', 'de', 'code'));
    fireEvent.click(screen.getByText('events.qrPoster'));
    await vi.waitFor(() => expect(service.getQrPrintBlob).toHaveBeenCalledWith(9, 'poster', 'de', 'code'));
    expect(click).toHaveBeenCalledTimes(2);
    click.mockRestore();
  });

  it('shows no print buttons while the gallery has no code', () => {
    renderCard({ access_code: null } as Partial<Event>);
    expect(screen.getByText('events.eventCode.none')).toBeInTheDocument();
    expect(screen.queryByTestId('event-code-print')).toBeNull();
    expect(screen.queryByText('events.qrTableCard')).toBeNull();
  });

  it('says so when a print download fails', async () => {
    service.getQrPrintBlob.mockRejectedValue(new Error('409'));
    renderCard();
    fireEvent.click(screen.getByText('events.qrPoster'));
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith('errors.downloadFailed'));
  });

  it('removes the code after confirmation', async () => {
    confirmMock.mockResolvedValue(true);
    service.removeAccessCode.mockResolvedValue({ access_code: null, access_code_display: null });
    renderCard();
    fireEvent.click(screen.getByText('events.eventCode.remove'));
    expect(await screen.findByText('events.eventCode.none')).toBeInTheDocument();
    expect(service.removeAccessCode).toHaveBeenCalledWith(9);
    expect(screen.getByText('events.eventCode.generate')).toBeInTheDocument();
  });

  it('keeps the code when removal is not confirmed', async () => {
    confirmMock.mockResolvedValue(false);
    renderCard();
    fireEvent.click(screen.getByText('events.eventCode.remove'));
    await Promise.resolve();
    expect(service.removeAccessCode).not.toHaveBeenCalled();
    expect(screen.getByTestId('event-code-value')).toHaveTextContent('K7M-4QX');
  });

  it('shows the code grouped', () => {
    renderCard();
    expect(screen.getByTestId('event-code-value')).toHaveTextContent('K7M-4QX');
  });

  it('renders nothing for an admin who may not see the gallery links', () => {
    const { container } = renderCard({ share_secrets_hidden: true, access_code: undefined });
    expect(container).toBeEmptyDOMElement();
  });

  it('hides the actions without events.edit', () => {
    perms.edit = false;
    renderCard();
    expect(screen.queryByText('events.eventCode.regenerate')).toBeNull();
    expect(screen.queryByText('events.eventCode.edit')).toBeNull();
  });

  it('saves a chosen code and shows it', async () => {
    service.setAccessCode.mockResolvedValue({ access_code: 'MUEPPER24', access_code_display: 'MUEPPER24' });
    renderCard();
    fireEvent.click(screen.getByText('events.eventCode.edit'));
    fireEvent.change(screen.getByLabelText('events.eventCode.customLabel'), { target: { value: 'mue-pper24' } });
    fireEvent.click(screen.getByText('common.save'));
    expect(await screen.findByTestId('event-code-value')).toHaveTextContent('MUEPPER24');
    expect(service.setAccessCode).toHaveBeenCalledWith(9, 'MUEPPER24');
  });

  it('says so when another gallery holds the code', async () => {
    service.setAccessCode.mockRejectedValue(Object.assign(new Error('taken'), { response: { status: 409 } }));
    renderCard();
    fireEvent.click(screen.getByText('events.eventCode.edit'));
    fireEvent.change(screen.getByLabelText('events.eventCode.customLabel'), { target: { value: 'TAKEN2' } });
    fireEvent.click(screen.getByText('common.save'));
    expect(await screen.findByText('events.eventCode.taken')).toBeInTheDocument();
  });

  it('refuses a code outside the alphabet without asking the server', () => {
    renderCard();
    fireEvent.click(screen.getByText('events.eventCode.edit'));
    fireEvent.change(screen.getByLabelText('events.eventCode.customLabel'), { target: { value: 'MUELLER24' } });
    fireEvent.click(screen.getByText('common.save'));
    expect(screen.getByText('events.eventCode.invalid')).toBeInTheDocument();
    expect(service.setAccessCode).not.toHaveBeenCalled();
  });

  it('says that codes are off when the server refuses a chosen code for that reason', async () => {
    service.setAccessCode.mockRejectedValue(Object.assign(new Error('off'), { response: { status: 409, data: { code: 'EVENT_CODES_DISABLED' } } }));
    renderCard();
    publicSettings.enabled = false; // switched off in another session
    fireEvent.click(screen.getByText('events.eventCode.edit'));
    fireEvent.change(screen.getByLabelText('events.eventCode.customLabel'), { target: { value: 'NEWC22' } });
    fireEvent.click(screen.getByText('common.save'));
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith('events.eventCode.disabled'));
    expect(screen.queryByText('events.eventCode.taken')).toBeNull();
    // The settings are refetched and the card turns into its disabled state.
    expect(await screen.findByTestId('event-code-disabled')).toBeInTheDocument();
    expect(screen.queryByTestId('event-code-value')).toBeNull();
    expect(screen.queryByText('events.eventCode.edit')).toBeNull();
  });

  it('says that codes are off when the server refuses a new code for that reason', async () => {
    confirmMock.mockResolvedValue(true);
    service.regenerateAccessCode.mockRejectedValue(Object.assign(new Error('off'), { response: { status: 409, data: { code: 'EVENT_CODES_DISABLED' } } }));
    renderCard();
    publicSettings.enabled = false; // switched off in another session
    fireEvent.click(screen.getByText('events.eventCode.regenerate'));
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith('events.eventCode.disabled'));
    expect(await screen.findByTestId('event-code-disabled')).toBeInTheDocument();
    expect(screen.queryByTestId('event-code-value')).toBeNull();
    expect(screen.queryByText('events.eventCode.copyLink')).toBeNull();
  });
});
