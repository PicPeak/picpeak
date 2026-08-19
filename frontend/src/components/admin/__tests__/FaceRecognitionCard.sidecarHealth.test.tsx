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
  const utils = render(
    <QueryClientProvider client={qc}>
      <FaceRecognitionCard eventId={1} />
    </QueryClientProvider>
  );
  return {
    ...utils,
    qc,
    rerender: () =>
      utils.rerender(
        <QueryClientProvider client={qc}>
          <FaceRecognitionCard eventId={1} />
        </QueryClientProvider>
      ),
  };
}

// Back-to-back refetchQueries calls coalesce, so drive probes one at a time.
async function probe(qc: QueryClient, times: number) {
  for (let i = 0; i < times; i++) {
    await qc.refetchQueries({ queryKey: ['admin-faces-health'] });
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe('FaceRecognitionCard — sidecar health during a scan', () => {
  beforeEach(() => get.mockReset());

  it('does not cry wolf on a single failed probe', async () => {
    // The sidecar serves /faces from an async handler that runs inference
    // synchronously, so one slow photo stalls /info past its 5s timeout. A
    // healthy sidecar can fail a probe; one failure must not raise the alarm.
    mockApi(facesPayload(), {
      url: 'http://picpeak-ml:8000',
      ok: false,
      reason: 'unreachable',
      error: 'timeout of 5000ms exceeded',
    });

    renderCard();

    await waitFor(() => expect(screen.getByText(/Scanning… 0 of 227/)).toBeInTheDocument());
    expect(screen.queryByText(/Can't reach the face-detection service/)).not.toBeInTheDocument();
  });

  it('stays quiet at two failures — still inside one inference window', async () => {
    // A single /faces call may legitimately run to FACE_ML_TIMEOUT_MS (30s),
    // blocking /info throughout, and two probes 15s apart both fit inside that
    // window. Warning at two would falsely accuse a healthy, working sidecar.
    mockApi(facesPayload(), {
      url: 'http://picpeak-ml:8000',
      ok: false,
      reason: 'unreachable',
      error: 'timeout of 5000ms exceeded',
    });

    const { rerender, qc } = renderCard();
    await waitFor(() => expect(screen.getByText(/Scanning… 0 of 227/)).toBeInTheDocument());

    await probe(qc, 1); // now two consecutive failures
    rerender();

    expect(screen.queryByText(/Can't reach the face-detection service/)).not.toBeInTheDocument();
    expect(screen.getByText(/Scanning… 0 of 227/)).toBeInTheDocument();
  });

  it('warns only after the streak outlasts one full inference window', async () => {
    mockApi(facesPayload(), {
      url: 'http://picpeak-ml:8000',
      ok: false,
      reason: 'unreachable',
      error: 'connect ECONNREFUSED 172.18.0.5:8000',
    });

    const { rerender, qc } = renderCard();
    await waitFor(() => expect(screen.getByText(/Scanning… 0 of 227/)).toBeInTheDocument());

    // Two more probes, pending unchanged -> the streak now spans >30s, past a
    // full inference window, so the sidecar really is gone rather than busy.
    await probe(qc, 2);
    rerender();

    await waitFor(() =>
      expect(screen.getByText(/Can't reach the face-detection service/)).toBeInTheDocument()
    );

    // URL and underlying error are both shown: without them the admin cannot
    // tell a stopped container from a token mismatch.
    expect(screen.getByText(/http:\/\/picpeak-ml:8000/)).toBeInTheDocument();
    expect(screen.getByText(/ECONNREFUSED/)).toBeInTheDocument();
    expect(screen.queryByText(/Scanning… 0 of 227/)).not.toBeInTheDocument();
  });

  it('treats a non-401 4xx as burning photos too, not as downtime', async () => {
    // classify() turns the whole 4xx range into SidecarRejectedError, so a
    // wrong FACE_ML_URL answering 404 marks photos failed exactly like a 401.
    // Reporting it as temporary downtime would promise recovery that never
    // comes.
    mockApi(facesPayload({ pending: 210, failed: 17 }), {
      url: 'http://wrong-host:8000',
      ok: false,
      reason: 'rejected',
      error: 'Sidecar answered 404 — check FACE_ML_URL points at picpeak-ml',
    });

    renderCard();

    await waitFor(() =>
      expect(screen.getByText(/answered, but not like the face-detection service/)).toBeInTheDocument()
    );
    expect(screen.queryByText(/resumes on its own/)).not.toBeInTheDocument();
  });

  it('tells the admin the sidecar needs FACE_ML_TOKEN to start at all', async () => {
    // The most likely first-run failure: FACE_ML_TOKEN has no default, so the
    // container raises at startup and never listens. That surfaces as a plain
    // connection refusal, and "just start it" is not enough to fix it.
    mockApi(facesPayload(), {
      url: 'http://picpeak-ml:8000',
      ok: false,
      reason: 'unreachable',
      error: 'connect ECONNREFUSED 172.18.0.5:8000',
    });

    const { rerender, qc } = renderCard();
    // let the first probe land before forcing the rest — the warning is
    // deliberately gated on three consecutive failures
    await waitFor(() => expect(screen.getByText(/Scanning… 0 of 227/)).toBeInTheDocument());
    await probe(qc, 2);
    rerender();

    await waitFor(() => expect(screen.getByText(/FACE_ML_TOKEN/)).toBeInTheDocument());
    expect(screen.getByText(/there is no default/)).toBeInTheDocument();
  });

  it('warns immediately on a rejected token, and says a re-scan is needed', async () => {
    // 401 becomes SidecarRejectedError, which faceQueue does NOT retry — every
    // claimed photo is marked `failed`. Promising the scan auto-resumes here
    // would be wrong, and the liveness guard must not mask it: the queue is
    // draining, just into failures.
    mockApi(facesPayload({ pending: 200, scanned: 0, failed: 27 }), {
      url: 'http://picpeak-ml:8000',
      ok: false,
      reason: 'unauthorized',
      error: 'Sidecar rejected the token (check FACE_ML_TOKEN on both containers)',
    });

    renderCard();

    await waitFor(() =>
      expect(screen.getByText(/rejecting our token/)).toBeInTheDocument()
    );
    // scoped to the message, not the Re-scan button that also matches /Re-scan/
    expect(screen.getByText(/then use Re-scan/)).toBeInTheDocument();
    expect(screen.getByText(/marked failed rather than retried/)).toBeInTheDocument();
    // must NOT claim it resumes on its own
    expect(screen.queryByText(/resumes on its own/)).not.toBeInTheDocument();
  });

  it('keeps the normal progress line when the sidecar is healthy', async () => {
    mockApi(facesPayload(), { url: 'http://picpeak-ml:8000', ok: true });

    renderCard();

    await waitFor(() =>
      expect(screen.getByText(/Scanning… 0 of 227/)).toBeInTheDocument()
    );
    expect(screen.queryByText(/Can't reach the face-detection service/)).not.toBeInTheDocument();
  });

  it('does not probe health on a clean idle card', async () => {
    mockApi(facesPayload({ in_progress: false, scanned: 227, pending: 0, failed: 0, people: 12 }), {
      url: 'http://picpeak-ml:8000',
      ok: false,
    });

    renderCard();

    await waitFor(() => expect(screen.getByText(/227 photos scanned/)).toBeInTheDocument());

    // Nothing queued and nothing failed — there is no question to answer, so
    // the card must not call the sidecar at all.
    expect(screen.queryByText(/Can't reach the face-detection service/)).not.toBeInTheDocument();
    expect(get.mock.calls.some(([url]: any[]) => String(url).includes('/faces/health'))).toBe(false);
  });

  it('still explains a 4xx after the scan has already burnt through the queue', async () => {
    // A 4xx marks photos failed with no backoff (faceQueue.js:139-152), so the
    // queue can empty before anyone opens the card. in_progress is false and
    // only "227 failed" remains — the diagnosis has to outlive the scan.
    mockApi(facesPayload({ in_progress: false, pending: 0, scanned: 0, failed: 227 }), {
      url: 'http://picpeak-ml:8000',
      ok: false,
      reason: 'unauthorized',
      error: 'Sidecar rejected the token (check FACE_ML_TOKEN on both containers)',
    });

    renderCard();

    await waitFor(() => expect(screen.getByText(/rejecting our token/)).toBeInTheDocument());
    // the counts the admin came for are still there, not replaced by the warning
    expect(screen.getByText(/227 failed/)).toBeInTheDocument();
  });

  it('does not blame the sidecar for per-photo failures when it is healthy', async () => {
    // Failures with a reachable sidecar mean undecodable images, not config.
    mockApi(facesPayload({ in_progress: false, pending: 0, scanned: 220, failed: 7 }), {
      url: 'http://picpeak-ml:8000',
      ok: true,
    });

    renderCard();

    await waitFor(() => expect(screen.getByText(/7 failed/)).toBeInTheDocument());
    expect(screen.queryByText(/rejecting our token/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Can't reach the face-detection service/)).not.toBeInTheDocument();
  });
});
