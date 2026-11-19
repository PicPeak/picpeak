/**
 * Guest identity before downloading (issue 2503): the gate the download
 * transports go through.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/guests.service', () => ({
  guestsService: { getDownloadTicket: vi.fn(async () => 'ticket-1') },
}));
vi.mock('../../services/feedback.service', () => ({
  feedbackService: { getGalleryFeedbackSettings: vi.fn(async () => ({ require_guest_for_download: false })) },
}));
import { guestsService } from '../../services/guests.service';
import { feedbackService } from '../../services/feedback.service';
import {
  GUEST_IDENTITY_REQUIRED_CODE, isDownloadIdentityCancelled, setDownloadIdentityGate,
  withDownloadIdentity, withGuestTicket,
} from '../downloadIdentity';
import { isDownloadLimitError } from '../downloadLimit';

const refusal = () => Object.assign(new Error('refused'), {
  response: {
    status: 403,
    // Downloads ask for a Blob, so the JSON error arrives as one.
    data: new Blob([JSON.stringify({ code: GUEST_IDENTITY_REQUIRED_CODE })], { type: 'application/json' }),
  },
});

afterEach(() => {
  setDownloadIdentityGate('party', null);
  vi.clearAllMocks();
});

describe('withDownloadIdentity', () => {
  it('runs the download straight away without a gate', async () => {
    const run = vi.fn(async () => 'done');
    expect(await withDownloadIdentity('party', run)).toBe('done');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('asks for the name before the download starts when the gallery wants it', async () => {
    const order: string[] = [];
    setDownloadIdentityGate('party', {
      required: true,
      ensure: vi.fn(async () => { order.push('prompt'); }),
      forget: vi.fn(),
    });
    await withDownloadIdentity('party', async () => { order.push('download'); });
    expect(order).toEqual(['prompt', 'download']);
  });

  it('starts nothing when the guest cancels, and callers can stay silent', async () => {
    setDownloadIdentityGate('party', {
      required: true,
      ensure: vi.fn(async () => { throw new Error('user_cancelled'); }),
      forget: vi.fn(),
    });
    const run = vi.fn();
    const error = await withDownloadIdentity('party', run).catch((e) => e);
    expect(run).not.toHaveBeenCalled();
    expect(isDownloadIdentityCancelled(error)).toBe(true);
    // Callers skip their generic "download failed" toast for these.
    expect(isDownloadLimitError(error)).toBe(true);
  });

  it('opens the prompt on a server refusal and tries the download once more', async () => {
    const gate = { required: false, ensure: vi.fn(async () => undefined), forget: vi.fn() };
    setDownloadIdentityGate('party', gate);
    const run = vi.fn()
      .mockRejectedValueOnce(refusal())
      .mockResolvedValueOnce('done');
    expect(await withDownloadIdentity('party', run)).toBe('done');
    expect(gate.forget).toHaveBeenCalledTimes(1);
    expect(gate.ensure).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('passes any other failure through untouched', async () => {
    const gate = { required: true, ensure: vi.fn(async () => undefined), forget: vi.fn() };
    setDownloadIdentityGate('party', gate);
    const failure = Object.assign(new Error('gone'), { response: { status: 404, data: {} } });
    await expect(withDownloadIdentity('party', async () => { throw failure; })).rejects.toBe(failure);
    expect(gate.forget).not.toHaveBeenCalled();
  });
});

describe('withGuestTicket', () => {
  it('leaves the URL alone outside guest identity mode', async () => {
    expect(await withGuestTicket('party', '/api/gallery/party/download-all')).toBe('/api/gallery/party/download-all');
    expect(guestsService.getDownloadTicket).not.toHaveBeenCalled();
    expect(feedbackService.getGalleryFeedbackSettings).not.toHaveBeenCalled();
  });

  it('leaves the URL alone when the gallery, read again, still does not ask', async () => {
    const gate = { required: false, ensure: vi.fn(async () => undefined), forget: vi.fn() };
    setDownloadIdentityGate('party', gate);
    expect(await withGuestTicket('party', '/api/gallery/party/download-all')).toBe('/api/gallery/party/download-all');
    vi.mocked(feedbackService.getGalleryFeedbackSettings).mockRejectedValueOnce(new Error('offline'));
    expect(await withGuestTicket('party', '/api/gallery/party/download-all')).toBe('/api/gallery/party/download-all');
    expect(gate.ensure).not.toHaveBeenCalled();
    expect(guestsService.getDownloadTicket).not.toHaveBeenCalled();
  });

  it('asks and adds a ticket when the setting was switched on after the page loaded', async () => {
    const gate = { required: false, ensure: vi.fn(async () => undefined), forget: vi.fn() };
    setDownloadIdentityGate('party', gate);
    vi.mocked(feedbackService.getGalleryFeedbackSettings).mockResolvedValueOnce({ require_guest_for_download: true });
    expect(await withGuestTicket('party', '/api/gallery/party/download-all'))
      .toBe('/api/gallery/party/download-all?guest_ticket=ticket-1');
    expect(gate.ensure).toHaveBeenCalledTimes(1);
  });

  it('starts no navigated download when the guest cancels that prompt', async () => {
    setDownloadIdentityGate('party', {
      required: false,
      ensure: vi.fn(async () => { throw new Error('user_cancelled'); }),
      forget: vi.fn(),
    });
    vi.mocked(feedbackService.getGalleryFeedbackSettings).mockResolvedValueOnce({ require_guest_for_download: true });
    const error = await withGuestTicket('party', '/api/gallery/party/download-all').catch((e) => e);
    expect(isDownloadIdentityCancelled(error)).toBe(true);
    expect(guestsService.getDownloadTicket).not.toHaveBeenCalled();
  });

  it('adds a download ticket to a navigated download when it does', async () => {
    setDownloadIdentityGate('party', { required: true, ensure: vi.fn(), forget: vi.fn() });
    expect(await withGuestTicket('party', '/api/gallery/party/download-all'))
      .toBe('/api/gallery/party/download-all?guest_ticket=ticket-1');
    expect(await withGuestTicket('party', '/api/gallery/party/download-jobs/t/file?part=1&parts=2'))
      .toBe('/api/gallery/party/download-jobs/t/file?part=1&parts=2&guest_ticket=ticket-1');
  });
});
