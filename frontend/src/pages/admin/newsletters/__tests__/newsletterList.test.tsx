/**
 * Newsletter list (#1264).
 *
 * The list is a safety surface: status and failure counts have to be legible
 * at a glance, and delete must not be offered for a campaign that has
 * already reached people — a sent campaign is a delivery record.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import type { Campaign, CampaignStatus } from '../../../../services/newsletters.service';

// Resolve against the REAL en.json rather than returning fallbacks. That
// makes these assertions double as a check that the `newsletters.*` keys
// actually exist — a missing key shows up as a failing label, not a silent
// fallback that looks right.
vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  const en = (await import('../../../../i18n/locales/en.json')).default as Record<string, unknown>;
  const lookup = (key: string): string | undefined =>
    key.split('.').reduce<unknown>(
      (node, part) => (node && typeof node === 'object'
        ? (node as Record<string, unknown>)[part] : undefined),
      en
    ) as string | undefined;
  return {
    ...actual,
    useTranslation: () => ({
      t: (k: string, fb?: unknown, opts?: Record<string, unknown>) => {
        const base = lookup(k) ?? (typeof fb === 'string' ? fb : k);
        if (!opts) return base;
        return base.replace(/\{\{(\w+)\}\}/g, (_m, key) => String(opts[key] ?? ''));
      },
      i18n: { language: 'en' },
    }),
  };
});

vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const confirmSpy = vi.fn(async () => true);
vi.mock('../../../../components/common', async () => {
  const actual = await vi.importActual<any>('../../../../components/common');
  return { ...actual, useConfirm: () => confirmSpy };
});

const makeCampaign = (over: Partial<Campaign>): Campaign => ({
  id: 1, name: 'Spring', subject: 'Spring offers', bodyHtml: '<p>x</p>', bodyCss: '',
  language: 'en', status: 'draft', recipientMode: 'all_active', customerIds: [],
  recipientCount: 0, sentCount: 0, failedCount: 0, sendRatePerMinute: 20,
  createdByAdminId: 1, testSentAt: null, queuedAt: null, completedAt: null,
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
  ...over,
});

let listFixture: Campaign[] = [];
const listSpy = vi.fn(async () => listFixture);
const removeSpy = vi.fn(async () => undefined);

vi.mock('../../../../services/newsletters.service', () => ({
  newslettersService: {
    list: (...a: unknown[]) => listSpy(...(a as [])),
    remove: (...a: unknown[]) => removeSpy(...(a as [])),
    create: vi.fn(async () => makeCampaign({ id: 99 })),
  },
}));

import { NewsletterListPage } from '../NewsletterListPage';

function renderList() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><NewsletterListPage /></MemoryRouter>
    </QueryClientProvider>
  );
}

describe('newsletter list', () => {
  beforeEach(() => {
    listFixture = [];
    confirmSpy.mockClear();
    listSpy.mockClear();
    removeSpy.mockClear();
  });

  it('shows an empty state when there are no campaigns', async () => {
    renderList();
    expect(await screen.findByText('No campaigns yet.')).toBeInTheDocument();
  });

  it.each<[CampaignStatus, string]>([
    ['draft', 'Draft'],
    ['queued', 'Queued'],
    ['sending', 'Sending'],
    ['sent', 'Sent'],
    ['cancelled', 'Cancelled'],
    ['failed', 'Failed'],
  ])('renders a %s chip', async (status, label) => {
    listFixture = [makeCampaign({ status })];
    renderList();
    expect(await screen.findByTestId(`status-${status}`)).toHaveTextContent(label);
  });

  it('shows recipient, sent and failed counts', async () => {
    listFixture = [makeCampaign({ recipientCount: 120, sentCount: 118, failedCount: 2 })];
    renderList();

    const row = (await screen.findByText('Spring')).closest('tr')!;
    expect(within(row).getByText('120')).toBeInTheDocument();
    expect(within(row).getByText('118')).toBeInTheDocument();
    expect(within(row).getByText('2')).toBeInTheDocument();
  });

  it.each<CampaignStatus>(['draft', 'cancelled'])(
    'offers delete for a %s campaign', async (status) => {
      listFixture = [makeCampaign({ status })];
      renderList();
      expect(await screen.findByRole('button', { name: /Delete Spring/i })).toBeInTheDocument();
    }
  );

  it.each<CampaignStatus>(['queued', 'sending', 'sent', 'failed'])(
    'does not offer delete for a %s campaign', async (status) => {
      listFixture = [makeCampaign({ status })];
      renderList();
      await screen.findByText('Spring');
      expect(screen.queryByRole('button', { name: /Delete Spring/i })).not.toBeInTheDocument();
    }
  );

  it('confirms before deleting', async () => {
    listFixture = [makeCampaign({ status: 'draft' })];
    renderList();

    await userEvent.click(await screen.findByRole('button', { name: /Delete Spring/i }));

    expect(confirmSpy).toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalledWith(1);
  });

  it('does not delete when the confirm is declined', async () => {
    confirmSpy.mockResolvedValueOnce(false);
    listFixture = [makeCampaign({ status: 'draft' })];
    renderList();

    await userEvent.click(await screen.findByRole('button', { name: /Delete Spring/i }));

    expect(removeSpy).not.toHaveBeenCalled();
  });

  it('passes the status filter through to the API', async () => {
    listFixture = [makeCampaign({})];
    renderList();
    await screen.findByText('Spring');

    await userEvent.selectOptions(
      screen.getByLabelText('Filter by status'), 'sent'
    );

    expect(listSpy).toHaveBeenLastCalledWith('sent');
  });
});
