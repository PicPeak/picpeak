/**
 * The event code card (issue 2495): shows the grouped code, saves a chosen
 * code (409 = taken, said in the field), removes a code, stays away from an
 * admin who may not hand out the gallery's links, and only says that codes
 * are off while the setting is off.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { toast } from 'react-toastify';
import { EventCodeCard } from '../EventCodeCard';
import type { Event } from '../../../../types';

const service = vi.hoisted(() => ({ regenerateAccessCode: vi.fn(), setAccessCode: vi.fn(), removeAccessCode: vi.fn() }));
const perms = vi.hoisted(() => ({ edit: true }));
const publicSettings = vi.hoisted(() => ({ enabled: true }));
const confirmMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../hooks/usePublicSettings', () => ({
  usePublicSettings: () => ({ data: { general_event_codes_enabled: publicSettings.enabled }, isLoading: false }),
}));
vi.mock('../../../../components/common/ConfirmDialog', () => ({ useConfirm: () => confirmMock }));
vi.mock('../../../../services/events.service', () => ({ eventsService: service }));
vi.mock('../../../../hooks/usePermission', () => ({ usePermission: () => perms.edit }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const baseEvent = { id: 9, slug: 'wedding', require_password: true, is_archived: false, access_code: 'K7M4QX' } as unknown as Event;
const renderCard = (over: Partial<Event> = {}) => render(<EventCodeCard event={{ ...baseEvent, ...over } as Event} />);

describe('EventCodeCard', () => {
  beforeEach(() => {
    service.regenerateAccessCode.mockReset();
    service.setAccessCode.mockReset();
    service.removeAccessCode.mockReset();
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
    fireEvent.click(screen.getByText('events.eventCode.edit'));
    fireEvent.change(screen.getByLabelText('events.eventCode.customLabel'), { target: { value: 'NEWC22' } });
    fireEvent.click(screen.getByText('common.save'));
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith('events.eventCode.disabled'));
    expect(screen.queryByText('events.eventCode.taken')).toBeNull();
  });

  it('says that codes are off when the server refuses a new code for that reason', async () => {
    confirmMock.mockResolvedValue(true);
    service.regenerateAccessCode.mockRejectedValue(Object.assign(new Error('off'), { response: { status: 409, data: { code: 'EVENT_CODES_DISABLED' } } }));
    renderCard();
    fireEvent.click(screen.getByText('events.eventCode.regenerate'));
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith('events.eventCode.disabled'));
    expect(screen.getByTestId('event-code-value')).toHaveTextContent('K7M-4QX');
  });
});
