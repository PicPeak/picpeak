/**
 * The event code card (issue 2495): shows the grouped code, saves a chosen
 * code (409 = taken, said in the field), and stays away from an admin who may
 * not hand out the gallery's links.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { EventCodeCard } from '../EventCodeCard';
import type { Event } from '../../../../types';

const service = vi.hoisted(() => ({ regenerateAccessCode: vi.fn(), setAccessCode: vi.fn() }));
const perms = vi.hoisted(() => ({ edit: true }));
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
  beforeEach(() => { service.regenerateAccessCode.mockReset(); service.setAccessCode.mockReset(); perms.edit = true; });

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
});
