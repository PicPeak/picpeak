/**
 * The participation invitation (#1110).
 *
 * Two properties matter here and are easy to break by accident:
 *
 *  - it is an INVITATION, so it appears only where an admin goes
 *    deliberately, and only while participation is actually off;
 *  - the activity ticker inside it is what triggers the daily rollup — the
 *    backend has no scheduler — so it must keep running on every admin page,
 *    including the ones where the banner is not rendered and the case where
 *    the install is already participating and the banner never renders at all.
 */
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import ProductUsageNotice from '../ProductUsageNotice';
import { productUsageService as service } from '../../../services/productUsage.service';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => {} }
}));
vi.mock('../../../contexts/PermissionsContext', () => ({
  usePermissions: () => ({ hasPermission: () => true })
}));
vi.mock('../../../services/productUsage.service', () => ({
  productUsageService: { status: vi.fn(), activity: vi.fn(), dismiss: vi.fn() }
}));

const status = (over = {}) => ({
  status: 'disabled',
  notice_dismissed: false,
  installation_id: null,
  collector_url: 'https://collector.example',
  schema_version: 'usage.v1',
  last_report_date: null,
  last_error: null,
  pending_action: null,
  last_packet: null,
  feedback_preferences: { name: '' },
  ...over
});

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <ProductUsageNotice />
      </MemoryRouter>
    </QueryClientProvider>
  );
  // Absence only means something once the status has actually landed.
  // Waiting on the service being *called* proved nothing: the component
  // returns null while `data` is undefined, so every negative assertion
  // passed even with the gate removed.
  return {
    settled: () =>
      waitFor(() => expect(client.getQueryData(['productUsage'])).toBeDefined())
  };
}

beforeEach(() => {
  vi.mocked(service.status).mockResolvedValue(status() as never);
  vi.mocked(service.activity).mockResolvedValue(undefined as never);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('product usage notice', () => {
  it.each(['/admin/dashboard', '/admin/settings', '/admin/settings?tab=usage'])(
    'invites participation on %s',
    async (path) => {
      renderAt(path);
      expect(await screen.findByText('productUsage.noticeTitle')).toBeInTheDocument();
      // The dismissal is permanent, so the label must not promise a return.
      expect(screen.getByText('productUsage.ignore')).toBeInTheDocument();
      expect(screen.getByText('productUsage.ignoreHint')).toBeInTheDocument();
    }
  );

  it.each(['/admin/events', '/admin/archives', '/admin/users'])(
    'stays out of the way on %s',
    async (path) => {
      const { settled } = renderAt(path);
      await settled();
      expect(screen.queryByText('productUsage.noticeTitle')).not.toBeInTheDocument();
    }
  );

  it.each(['active', 'activation_pending', 'deletion_pending', 'identity_conflict'])(
    'does not invite while participation is %s',
    async (state) => {
      vi.mocked(service.status).mockResolvedValue(status({ status: state }) as never);
      const { settled } = renderAt('/admin/dashboard');
      await settled();
      expect(screen.queryByText('productUsage.noticeTitle')).not.toBeInTheDocument();
    }
  );

  it('does not invite again once ignored', async () => {
    vi.mocked(service.status).mockResolvedValue(status({ notice_dismissed: true }) as never);
    const { settled } = renderAt('/admin/dashboard');
    await settled();
    expect(screen.queryByText('productUsage.noticeTitle')).not.toBeInTheDocument();
  });

  it('still reports activity on a page where the banner is hidden', async () => {
    // The rollup must not depend on which page the admin happens to be on.
    const { settled } = renderAt('/admin/events');
    await waitFor(() => expect(service.activity).toHaveBeenCalled());
    await settled();
    expect(screen.queryByText('productUsage.noticeTitle')).not.toBeInTheDocument();
  });

  it('still reports activity for an install that is already participating', async () => {
    // The banner never renders in this state; reporting must continue anyway.
    vi.mocked(service.status).mockResolvedValue(status({ status: 'active' }) as never);
    const { settled } = renderAt('/admin/dashboard');
    await waitFor(() => expect(service.activity).toHaveBeenCalled());
    await settled();
    expect(screen.queryByText('productUsage.noticeTitle')).not.toBeInTheDocument();
  });
});
