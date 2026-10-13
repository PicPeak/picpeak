/**
 * A render error in a route still shows the app's own error page.
 *
 * The app runs on a data router (for the unsaved-changes blocker), and a data
 * router catches route errors itself: without an errorElement it replaces the
 * whole app with its developer-facing "Unexpected Application Error!" screen.
 * App.tsx hands the error back to PageErrorBoundary instead.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config/api')>()),
  api: {
    get: vi.fn().mockResolvedValue({ data: {} }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
    defaults: { headers: { common: {} } },
  },
}));

vi.mock('../pages/public/LegalPage', () => ({
  LegalPage: () => { throw new Error('boom in a route'); },
}));

describe('App route errors', () => {
  it("renders the app's error page, not the router's default", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    window.history.pushState({}, '', '/impressum');
    const { default: App } = await import('../App');
    render(<App />);

    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
    // PageErrorBoundary's two actions.
    expect(screen.getAllByRole('button')).toHaveLength(2);
    expect(screen.queryByText(/Unexpected Application Error/i)).not.toBeInTheDocument();
  }, 60000);
});
