import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup
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
    disable: vi.fn(),
    retry: vi.fn(),
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
