/**
 * A scan whose sidecar is unreachable does not fail — faceQueue releases the
 * photo back to `pending` and retries forever. That is deliberate, but it made
 * "Scanning… 0 of N" indistinguishable from a missing picpeak-ml container,
 * which is exactly what a user hit on discussions/1069: 0/227 for 30 minutes
 * with no explanation anywhere in the UI.
 *
 * These pin the branch: while a scan is in progress, a failing connection test
 * replaces the spinner with something actionable, and a passing one leaves the
 * spinner alone.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { FaceRecognitionCard } from '../FaceRecognitionCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: any) => opts?.defaultValue ?? _key,
  }),
  // src/i18n/config.ts is pulled in transitively via ErrorBoundary and calls
  // .use(initReactI18next) at import time.
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('../PeopleManagerModal', () => ({
  PeopleManagerModal: () => null,
}));

vi.mock('react-toastify', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const get = vi.fn();
vi.mock('../../../config/api', () => ({
  api: {
    get: (...args: any[]) => get(...args),
    put: vi.fn().mockResolvedValue({ data: {} }),
    post: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

function facesPayload(over: Record<string, any> = {}) {
  return {
    enabled: true,
    visible_to_guests: true,
    last_scan_at: null,
    status: {
      scanned: 0,
      total: 227,
      pending: 227,
      failed: 0,
      people: 0,
      in_progress: true,
      ...over,
    },
  };
}

function mockApi(faces: any, health: any) {
  get.mockImplementation((rawUrl: unknown) => {
    const url = String(rawUrl ?? '');
    if (url.includes('/faces/health')) {
      if (health === 'reject') return Promise.reject(new Error('boom'));
      return Promise.resolve({ data: health });
    }
    if (url.includes('/auto-categories')) return Promise.resolve({ data: { enabled: false } });
    return Promise.resolve({ data: faces });
  });
}

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <FaceRecognitionCard eventId={1} />
    </QueryClientProvider>
  );
}

describe('FaceRecognitionCard — sidecar health during a scan', () => {
  beforeEach(() => get.mockReset());

  it('replaces the spinner with an actionable message when the sidecar is unreachable', async () => {
    mockApi(facesPayload(), {
      url: 'http://picpeak-ml:8000',
      ok: false,
      error: 'connect ECONNREFUSED 172.18.0.5:8000',
    });

    renderCard();

    await waitFor(() =>
      expect(screen.getByText(/Can't reach the face-detection service/)).toBeInTheDocument()
    );

    // The sidecar URL and the underlying error are both shown: without them the
    // admin cannot tell a stopped container from a token mismatch.
    expect(screen.getByText(/http:\/\/picpeak-ml:8000/)).toBeInTheDocument();
    expect(screen.getByText(/ECONNREFUSED/)).toBeInTheDocument();

    // and the misleading progress line is gone
    expect(screen.queryByText(/Scanning… 0 of 227/)).not.toBeInTheDocument();
  });

  it('keeps the normal progress line when the sidecar is healthy', async () => {
    mockApi(facesPayload(), { url: 'http://picpeak-ml:8000', ok: true });

    renderCard();

    await waitFor(() =>
      expect(screen.getByText(/Scanning… 0 of 227/)).toBeInTheDocument()
    );
    expect(screen.queryByText(/Can't reach the face-detection service/)).not.toBeInTheDocument();
  });

  it('does not probe health when no scan is running', async () => {
    mockApi(facesPayload({ in_progress: false, scanned: 227, pending: 0, people: 12 }), {
      url: 'http://picpeak-ml:8000',
      ok: false,
    });

    renderCard();

    await waitFor(() => expect(screen.getByText(/227 photos scanned/)).toBeInTheDocument());

    // An idle card must not warn about a sidecar it has no reason to call —
    // the container is only needed while there is queued work.
    expect(screen.queryByText(/Can't reach the face-detection service/)).not.toBeInTheDocument();
    expect(get.mock.calls.some(([url]: any[]) => String(url).includes('/faces/health'))).toBe(false);
  });
});
