/**
 * Newsletter composer (#1264).
 *
 * Two things are worth pinning here, and they are both about not mailing
 * 2 000 people by accident:
 *
 *  1. The queue button is inert until there is a subject, a body and at
 *     least one recipient, and the confirm dialog repeats the SERVER's
 *     recipient count — not a locally-guessed one.
 *  2. The preview iframe is sandboxed with no allow-scripts. The body is
 *     sanitized server-side; this is the second line of defence and the only
 *     DOM campaign HTML ever reaches.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import type { Campaign } from '../../../../services/newsletters.service';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (k: string, fb?: unknown, opts?: Record<string, unknown>) => {
        const base = typeof fb === 'string' ? fb : k;
        if (!opts) return base;
        return base.replace(/\{\{(\w+)\}\}/g, (_m, key) => String(opts[key] ?? ''));
      },
      i18n: { language: 'en' },
    }),
  };
});

vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// TipTap pulls a large editor bundle and contenteditable behaviour we don't
// need here — a plain textarea is enough to drive the body field.
vi.mock('../../../../components/admin/EmailTemplateEditor', () => ({
  EmailTemplateEditor: ({ content, onChange }: { content: string; onChange: (v: string) => void }) => (
    <textarea aria-label="Body" value={content} onChange={(e) => onChange(e.target.value)} />
  ),
}));

// The composer gates manual recipient mode on `customers.view` (#1264
// review), so it now consults PermissionsContext.
let grantedPermissions = ['newsletters.view', 'newsletters.send', 'customers.view'];
vi.mock('../../../../contexts/PermissionsContext', () => ({
  usePermissions: () => ({
    hasPermission: (p: string) => grantedPermissions.includes(p),
    isLoading: false,
  }),
}));

const confirmSpy = vi.fn(async () => true);
vi.mock('../../../../components/common', async () => {
  const actual = await vi.importActual<any>('../../../../components/common');
  return { ...actual, useConfirm: () => confirmSpy };
});

const baseCampaign: Campaign = {
  id: 7,
  name: 'Spring news',
  subject: 'Our spring offers',
  bodyHtml: '<p>Hi {{first_name}}</p>',
  bodyCss: '',
  language: 'en',
  status: 'draft',
  recipientMode: 'all_active',
  customerIds: [],
  recipientCount: 0,
  sentCount: 0,
  failedCount: 0,
  sendRatePerMinute: 20,
  createdByAdminId: 1,
  testSentAt: null,
  queuedAt: null,
  completedAt: null,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
};

let campaignFixture: Campaign = baseCampaign;
let resolution = {
  recipientCount: 42, skippedOptOut: 3, skippedNoEmail: 0,
  sendRatePerMinute: 20, estimatedMinutes: 3,
};
const queueSpy = vi.fn(async () => ({ queued: 42, skippedOptOut: 3, sendRatePerMinute: 20 }));
const resolveSpy = vi.fn(async () => resolution);

vi.mock('../../../../services/newsletters.service', () => ({
  newslettersService: {
    get: vi.fn(async () => ({ campaign: campaignFixture, recipientSummary: {} })),
    update: vi.fn(async () => campaignFixture),
    preview: vi.fn(async () => ({
      subject: 'Our spring offers',
      html: '<html><body><p>Hi Alex</p></body></html>',
      language: 'en',
      isSample: true,
    })),
    resolveRecipients: (...a: unknown[]) => resolveSpy(...(a as [])),
    queue: (...a: unknown[]) => queueSpy(...(a as [])),
    sendTest: vi.fn(async () => undefined),
  },
}));

vi.mock('../../../../services/customerAdmin.service', () => ({
  customerAdminService: {
    list: vi.fn(async () => [
      { id: 1, email: 'a@example.com', displayName: 'Ada', isActive: true, createdAt: '', lastLogin: null,
        firstName: null, lastName: null, salutation: null, companyName: null },
    ]),
  },
}));

import { NewsletterComposerPage } from '../NewsletterComposerPage';

function renderComposer() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/admin/clients/newsletters/7/edit']}>
        <Routes>
          <Route path="/admin/clients/newsletters/:id/edit" element={<NewsletterComposerPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('newsletter composer', () => {
  beforeEach(() => {
    grantedPermissions = ['newsletters.view', 'newsletters.send', 'customers.view'];
    campaignFixture = { ...baseCampaign };
    resolution = {
      recipientCount: 42, skippedOptOut: 3, skippedNoEmail: 0,
      sendRatePerMinute: 20, estimatedMinutes: 3,
    };
    confirmSpy.mockClear();
    queueSpy.mockClear();
    resolveSpy.mockClear();
  });

  it("shows the server's recipient count and opt-out skips", async () => {
    renderComposer();
    const summary = await screen.findByTestId('recipient-summary');
    // The count starts at 0 and is replaced by the server's dry run.
    await waitFor(() => expect(summary).toHaveTextContent('42 recipients'));
    expect(summary).toHaveTextContent('3 skipped (opted out)');
  });

  it('renders the preview in a sandboxed iframe with no allow-scripts', async () => {
    renderComposer();
    await screen.findByTestId('recipient-summary');

    await userEvent.click(screen.getByRole('button', { name: /Refresh preview/i }));

    const iframe = await screen.findByTestId('newsletter-preview');
    // Empty sandbox = every restriction on, scripts included.
    expect(iframe.getAttribute('sandbox')).toBe('');
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-scripts');
    // srcdoc, not src — the HTML never becomes a navigable same-origin doc.
    expect(iframe).toHaveAttribute('srcdoc');
  });

  it('disables the queue button when there are no recipients', async () => {
    resolution = { ...resolution, recipientCount: 0 };
    renderComposer();
    await screen.findByTestId('recipient-summary');
    await waitFor(() => expect(resolveSpy).toHaveBeenCalled());

    expect(screen.getByRole('button', { name: /Queue campaign/i })).toBeDisabled();
  });

  it('disables the queue button when the body is empty', async () => {
    campaignFixture = { ...baseCampaign, bodyHtml: '' };
    renderComposer();
    const summary = await screen.findByTestId('recipient-summary');
    // 42 recipients resolved — so the button can only be disabled by the
    // missing bodyHtml, not by an empty recipient list.
    await waitFor(() => expect(summary).toHaveTextContent('42 recipients'));

    expect(screen.getByRole('button', { name: /Queue campaign/i })).toBeDisabled();
  });

  it('disables the queue button when the subject is empty', async () => {
    campaignFixture = { ...baseCampaign, subject: '' };
    renderComposer();
    const summary = await screen.findByTestId('recipient-summary');
    // 42 recipients resolved — so the button can only be disabled by the
    // missing subject, not by an empty recipient list.
    await waitFor(() => expect(summary).toHaveTextContent('42 recipients'));

    expect(screen.getByRole('button', { name: /Queue campaign/i })).toBeDisabled();
  });

  it('confirms with the recipient count and rate before queueing', async () => {
    renderComposer();
    await screen.findByTestId('recipient-summary');

    await userEvent.click(screen.getByRole('button', { name: /Queue campaign/i }));

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    const opts = confirmSpy.mock.calls[0][0] as { message: string; confirmLabel: string };
    expect(opts.message).toContain('42 customers');
    expect(opts.message).toContain('20 per minute');
    expect(opts.message).toContain('roughly 3 min');
    expect(opts.confirmLabel).toContain('42');
    expect(queueSpy).toHaveBeenCalledWith(7);
  });

  it('does not queue when the confirm is declined', async () => {
    confirmSpy.mockResolvedValueOnce(false);
    renderComposer();
    await screen.findByTestId('recipient-summary');

    await userEvent.click(screen.getByRole('button', { name: /Queue campaign/i }));

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(queueSpy).not.toHaveBeenCalled();
  });

  it('switching to manual mode reveals the customer picker', async () => {
    renderComposer();
    await screen.findByTestId('recipient-summary');

    await userEvent.click(screen.getByRole('radio', { name: /Pick customers/i }));

    expect(await screen.findByText('Ada')).toBeInTheDocument();
  });

  it('refuses to edit a campaign that is already queued', async () => {
    campaignFixture = { ...baseCampaign, status: 'queued' };
    renderComposer();

    expect(await screen.findByText(/can no longer be edited/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Queue campaign/i })).not.toBeInTheDocument();
  });

  it('hides manual mode from a role that cannot read customers', async () => {
    // The picker reads /admin/customers, which needs `customers.view`. Showing
    // the radio to a newsletters-only role produced an empty list with no
    // explanation (#1264 review).
    grantedPermissions = ['newsletters.view', 'newsletters.send'];
    renderComposer();
    await screen.findByTestId('recipient-summary');

    expect(screen.queryByRole('radio', { name: /Pick customers/i })).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /All active customers/i })).toBeInTheDocument();
  });
});
