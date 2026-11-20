import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const { get, openGalleryDocument } = vi.hoisted(() => ({ get: vi.fn(), openGalleryDocument: vi.fn() }));
vi.mock('../../../utils/eventCode', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/eventCode')>()),
  openGalleryDocument,
}));
vi.mock('../../../config/api', () => ({ api: { get } }));
vi.mock('../../../hooks/usePublicSettings', () => ({ usePublicSettings: () => ({ data: undefined }) }));
vi.mock('../../../hooks/useShowAgbLink', () => ({ useShowAgbLink: () => false }));
vi.mock('../../../components/common/PoweredBy', () => ({ PoweredBy: () => null }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback || key }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

import { EventCodePage } from '../EventCodePage';

const mount = (entry: string) => render(
  <MemoryRouter initialEntries={[entry]}>
    <Routes>
      <Route path="/code" element={<EventCodePage />} />
      <Route path="/code/:code" element={<EventCodePage />} />
    </Routes>
  </MemoryRouter>
);

const field = () => screen.getByLabelText('Event code') as HTMLInputElement;
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Open gallery' }));
const notFound = 'We could not find a gallery for this code. Please check it and try again.';

describe('event code entry page (issue 2495)', () => {
  beforeEach(() => { get.mockReset(); openGalleryDocument.mockReset(); });

  it('looks up the typed code, normalised, and opens the gallery path it answers', async () => {
    get.mockResolvedValue({ data: { path: '/gallery/wedding/abc123' } });
    mount('/code');
    fireEvent.change(field(), { target: { value: 'k7m-4qx' } });
    expect(field().value).toBe('K7M-4QX');
    submit();
    // A full document load, so the gallery's own CSP headers apply.
    await waitFor(() => expect(openGalleryDocument).toHaveBeenCalledWith('/gallery/wedding/abc123'));
    expect(get).toHaveBeenCalledWith('/public/event-code/K7M4QX');
  });

  it('fills in and submits a code from the path once', async () => {
    get.mockResolvedValue({ data: { path: '/gallery/abc123' } });
    mount('/code/k7m4qx');
    await waitFor(() => expect(openGalleryDocument).toHaveBeenCalledWith('/gallery/abc123'));
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('/public/event-code/K7M4QX');
  });

  it('fills in and submits a code from ?code=', async () => {
    get.mockRejectedValue(Object.assign(new Error('nf'), { response: { status: 404 } }));
    mount('/code?code=K7M-4QX');
    expect(await screen.findByText(notFound)).toBeInTheDocument();
    expect(field().value).toBe('K7M-4QX');
    expect(get).toHaveBeenCalledWith('/public/event-code/K7M4QX');
  });

  it('says not found for an unknown code and stays on the page', async () => {
    get.mockRejectedValue(Object.assign(new Error('nf'), { response: { status: 404 } }));
    mount('/code');
    fireEvent.change(field(), { target: { value: 'ZZZZZZ' } });
    submit();
    expect(await screen.findByText(notFound)).toBeInTheDocument();
    expect(openGalleryDocument).not.toHaveBeenCalled();
  });

  it('does not spend a lookup on a code that cannot exist', async () => {
    mount('/code');
    fireEvent.change(field(), { target: { value: 'K7M0QX' } });
    submit();
    expect(await screen.findByText(notFound)).toBeInTheDocument();
    fireEvent.change(field(), { target: { value: '' } });
    submit();
    expect(await screen.findByText('Please enter your event code.')).toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });

  it('tells the guest to wait when rate limited', async () => {
    get.mockRejectedValue(Object.assign(new Error('rl'), { response: { status: 429 } }));
    mount('/code');
    fireEvent.change(field(), { target: { value: 'K7M4QX' } });
    submit();
    expect(await screen.findByText('Too many attempts. Please wait a few minutes and try again.')).toBeInTheDocument();
  });

  it('never follows an answer that is not a gallery on this site', async () => {
    get.mockResolvedValue({ data: { path: 'https://evil.example/gallery/x' } });
    mount('/code');
    fireEvent.change(field(), { target: { value: 'K7M4QX' } });
    submit();
    expect(await screen.findByText(notFound)).toBeInTheDocument();
    expect(openGalleryDocument).not.toHaveBeenCalled();
  });
});
