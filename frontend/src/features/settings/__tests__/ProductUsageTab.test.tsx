import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  within
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import ProductUsageTab from '../tabs/ProductUsageTab';
import {
  productUsageService as service,
  type UsageStatus
} from '../../../services/productUsage.service';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  // The tab imports from the components/common barrel, which reaches
  // ErrorBoundary -> i18n/config, and that calls .use(initReactI18next) at
  // import time. Same shim as FaceRecognitionCard.sidecarHealth.test.tsx.
  initReactI18next: { type: '3rdParty', init: () => {} }
}));
vi.mock('../../../components/common/ConfirmDialog', () => ({
  useConfirm: () => async () => true
}));
vi.mock('../../../services/productUsage.service', () => ({
  productUsageService: {
    status: vi.fn(),
    enable: vi.fn(),
    upgradeConsent: vi.fn(),
    disable: vi.fn(),
    retry: vi.fn(),
    abandon: vi.fn(),
    preview: vi.fn(),
    export: vi.fn(),
    preferences: vi.fn(),
    feedback: vi.fn(),
    portalSession: vi.fn()
  }
}));
const status: UsageStatus = {
  status: 'disabled',
  notice_dismissed: false,
  installation_id: null,
  collector_url: 'https://usage.picpeak.app',
  schema_version: 'usage.v1',
  last_report_date: null,
  last_error: null,
  pending_action: null,
  last_packet: null,
  feedback_preferences: { name: 'Remembered private name' }
};
const mount = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ProductUsageTab />
    </QueryClientProvider>
  );
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(service.status).mockResolvedValue({ ...status });
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
});
afterEach(cleanup);
it('shows every v2 signal locally before participation, without collector calls', async () => {
  mount();
  await screen.findByText('productUsage.catalogTitle');
  expect(screen.getAllByRole('heading', { level: 4, hidden: true })).toHaveLength(73);
  expect(service.enable).not.toHaveBeenCalled();
  expect(service.preview).not.toHaveBeenCalled();
  expect(service.upgradeConsent).not.toHaveBeenCalled();
});
it('existing v1 requires renewed unchecked consent; cancellation keeps v1 unchanged', async () => {
  vi.mocked(service.status).mockResolvedValue({ ...status, status: 'active', consent_update_available: true });
  vi.mocked(service.upgradeConsent).mockResolvedValue({ delivered: false, queued: true, state: { ...status, status: 'active', pending_action: 'consent' } });
  mount();
  fireEvent.click(await screen.findByText('productUsage.reviewUpgrade'));
  let dialog = within(screen.getByRole('dialog'));
  expect(dialog.getByRole('button', { name: 'productUsage.upgrade' })).toBeDisabled();
  expect(dialog.getByRole('checkbox')).not.toBeChecked();
  expect(dialog.getByText('productUsage.versionDisclosure')).toBeInTheDocument();
  fireEvent.click(dialog.getByRole('button', { name: 'productUsage.cancel' }));
  expect(service.upgradeConsent).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('productUsage.reviewUpgrade'));
  dialog = within(screen.getByRole('dialog'));
  fireEvent.click(dialog.getByRole('checkbox'));
  fireEvent.click(dialog.getByRole('button', { name: 'productUsage.upgrade' }));
  await waitFor(() => expect(service.upgradeConsent).toHaveBeenCalledTimes(1));
  expect(service.enable).not.toHaveBeenCalled();
  expect(await screen.findByText('productUsage.queued')).toBeInTheDocument();
});
it('pending v2 confirmation clearly keeps v1 and cannot queue another upgrade', async () => {
  vi.mocked(service.status).mockResolvedValue({ ...status, status: 'active', consent_update_available: true, pending_action: 'consent' });
  mount();
  expect(await screen.findByText('productUsage.upgradePending')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'productUsage.reviewUpgrade' })).toBeDisabled();
  expect(service.upgradeConsent).not.toHaveBeenCalled();
});
describe('product usage controls', () => {
  it('offers identity-free audit receipts after opt-out without restoring participation controls', async () => {
    vi.mocked(service.status).mockResolvedValue({
      ...status,
      privacy_receipts: {
        last_deletion: {
          receipt_version: 'local-audit.v1',
          kind: 'deletion',
          status: 'collector-confirmed'
        }
      }
    });
    mount();
    expect(
      await screen.findByRole('button', { name: 'productUsage.auditDownload' })
    ).toBeEnabled();
    expect(
      screen.getByText('productUsage.auditDescription')
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText('productUsage.hash')
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('productUsage.feedbackTitle')
    ).not.toBeInTheDocument();
  });
  it('requires the disclosure and an unchecked-by-default consent before enabling', async () => {
    mount();
    fireEvent.click(await screen.findByText('productUsage.review'));
    const enable = screen.getByRole('button', { name: 'productUsage.enable' });
    expect(enable).toBeDisabled();
    for (const key of [
      'fields',
      'excluded',
      'transport',
      'visibility',
      'deletion',
      'feedbackDisclosure'
    ])
      expect(screen.getByText(`productUsage.${key}`)).toBeInTheDocument();
    expect(service.enable).not.toHaveBeenCalled();
    expect(service.preview).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('productUsage.consentCheck'));
    fireEvent.click(enable);
    await waitFor(() => expect(service.enable).toHaveBeenCalledTimes(1));
  });
  it('sends anonymous private feedback even when a remembered name exists', async () => {
    vi.mocked(service.status).mockResolvedValue({
      ...status,
      status: 'active',
      installation_id: 'a'.repeat(64)
    });
    vi.mocked(service.feedback).mockResolvedValue({
      delivered: true,
      state: { ...status, status: 'active' }
    });
    mount();
    await screen.findByText('productUsage.feedbackTitle');
    expect(screen.getByLabelText('productUsage.includeName')).not.toBeChecked();
    fireEvent.change(screen.getByLabelText('productUsage.subject'), {
      target: { value: 'Feedback title' }
    });
    fireEvent.change(screen.getByLabelText('productUsage.message'), {
      target: { value: 'Useful details' }
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'productUsage.sendFeedback' })
    );
    await waitFor(() =>
      expect(service.feedback).toHaveBeenCalledWith({
        kind: 'feedback',
        title: 'Feedback title',
        body: 'Useful details',
        name: '',
        allow_public: false,
        allow_marketing: false
      })
    );
  });
  it('requires a separate marketing choice and clears it when publication permission is removed', async () => {
    vi.mocked(service.status).mockResolvedValue({
      ...status,
      status: 'active'
    });
    mount();
    fireEvent.change(await screen.findByLabelText('productUsage.kind'), {
      target: { value: 'testimonial' }
    });
    expect(screen.getByLabelText('productUsage.allowPublic')).not.toBeChecked();
    expect(screen.getByLabelText('productUsage.allowMarketing')).toBeDisabled();
    fireEvent.click(screen.getByLabelText('productUsage.allowPublic'));
    fireEvent.click(screen.getByLabelText('productUsage.allowMarketing'));
    expect(screen.getByLabelText('productUsage.allowMarketing')).toBeChecked();
    fireEvent.click(screen.getByLabelText('productUsage.allowPublic'));
    expect(
      screen.getByLabelText('productUsage.allowMarketing')
    ).not.toBeChecked();
  });
  it('keeps deletion pending explicit and offers retry without rejoining or sending feedback', async () => {
    vi.mocked(service.status).mockResolvedValue({
      ...status,
      status: 'deletion_pending',
      last_error: 'DELIVERY_FAILED'
    });
    mount();
    await screen.findByText('productUsage.states.deletion_pending');
    expect(screen.queryByText('productUsage.review')).not.toBeInTheDocument();
    expect(
      screen.queryByText('productUsage.feedbackTitle')
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'productUsage.retry' }));
    await waitFor(() => expect(service.retry).toHaveBeenCalled());
  });
});

describe('a withdrawal that can never be signed', () => {
  const stuck: UsageStatus = {
    ...status,
    status: 'deletion_pending',
    installation_id: 'a'.repeat(64),
    schema_version: 'usage.v2',
    last_error: 'SIGNING_KEY_UNREADABLE',
    can_abandon: true
  };

  it('explains the dead end and offers the only remaining exit', async () => {
    vi.mocked(service.status).mockResolvedValue(stuck);
    vi.mocked(service.abandon).mockResolvedValue({ ...status });
    mount();

    // The operator is told what happened before being offered the exit.
    await screen.findByText('productUsage.signingKeyUnreadable');
    await screen.findByText('productUsage.abandonExplanation');
    fireEvent.click(await screen.findByText('productUsage.abandon'));
    await waitFor(() => expect(service.abandon).toHaveBeenCalledTimes(1));
  });

  it('does not offer it for a withdrawal that is merely undelivered', async () => {
    vi.mocked(service.status).mockResolvedValue({
      ...stuck,
      last_error: 'DELIVERY_FAILED',
      can_abandon: false
    });
    mount();
    await screen.findByText('productUsage.deliveryProblem');
    expect(screen.queryByText('productUsage.abandon')).toBeNull();
  });
});

it('says the sender is waiting rather than leaving a bare error on screen', async () => {
  vi.mocked(service.status).mockResolvedValue({
    ...status,
    status: 'active',
    schema_version: 'usage.v2',
    installation_id: 'a'.repeat(64),
    last_error: 'DELIVERY_FAILED',
    retry_after: Date.now() + 600000
  });
  mount();
  await screen.findByText('productUsage.retryScheduled');
});

it('marks a deletion receipt as belonging to an earlier participation', async () => {
  const receipts = { last_deletion: { kind: 'deletion' } };
  vi.mocked(service.status).mockResolvedValue({
    ...status,
    status: 'active',
    schema_version: 'usage.v2',
    installation_id: 'a'.repeat(64),
    privacy_receipts: receipts
  });
  mount();
  await screen.findByText('productUsage.auditPreviousParticipation');

  cleanup();
  // Withdrawn: the same receipt now describes the participation just ended,
  // so the qualifier would be wrong.
  vi.mocked(service.status).mockResolvedValue({ ...status, privacy_receipts: receipts });
  mount();
  await screen.findByText('productUsage.auditTitle');
  expect(screen.queryByText('productUsage.auditPreviousParticipation')).toBeNull();
});

it('returns focus to the control that opened the consent dialog', async () => {
  mount();
  const trigger = await screen.findByText('productUsage.review');
  trigger.focus();
  expect(document.activeElement).toBe(trigger);

  fireEvent.click(trigger);
  await screen.findByText('productUsage.consentTitle');
  fireEvent.click(screen.getByText('productUsage.cancel'));

  // Without the restore this lands on <body>, dropping a keyboard user back
  // to the top of the page (WCAG 2.4.3).
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByText('productUsage.review')
    )
  );
});
