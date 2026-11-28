import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SetupPage } from '../SetupPage';
import { productUsageService as usage } from '../../services/productUsage.service';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('../../contexts', () => ({ useAdminAuth: () => ({ login: vi.fn() }) }));
vi.mock('../../services/setup.service', () => ({ setupService: {
  getSetupStatus: vi.fn().mockResolvedValue({ needsAdmin: true }),
  verifyToken: vi.fn().mockResolvedValue({}),
  createInitialAdmin: vi.fn().mockResolvedValue({ user: {
    id: 1, username: 'owner', email: 'owner@example.test', role: { name: 'super_admin' },
  } }),
  completeSetup: vi.fn().mockResolvedValue({}),
} }));
vi.mock('../../services/settings.service', () => ({ settingsService: {
  getSettingsByType: vi.fn().mockResolvedValue({ general_site_url: 'https://picpeak.example.test' }),
} }));
vi.mock('../../services/featureFlags.service', () => ({ featureFlagsService: {
  update: vi.fn().mockResolvedValue({}),
} }));
vi.mock('../../services/productUsage.service', () => ({ productUsageService: {
  status: vi.fn(), enable: vi.fn(), promptSeen: vi.fn().mockResolvedValue({}),
} }));
vi.mock('../../components/admin/PicpeakBackupCard', () => ({ PicpeakRestoreCard: () => null }));
vi.mock('../../components/admin/SetupEventTypesStep', () => ({
  SetupEventTypesStep: ({ onDone }: { onDone: () => void }) => <button onClick={onDone}>Finish event types</button>,
}));
vi.mock('../../components/admin/SetupConfigStep', () => ({
  SetupConfigStep: ({ onDone }: { onDone: () => void }) => <button onClick={onDone}>Finish configuration</button>,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(usage.status).mockResolvedValue({ status: 'disabled', collector_url: 'https://custom-collector.example.test' } as never);
  vi.mocked(usage.enable).mockResolvedValue({ status: 'active' } as never);
  vi.mocked(usage.promptSeen).mockResolvedValue({ status: 'disabled', prompt_shown: true } as never);
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
});
afterEach(cleanup);

let client: QueryClient;
async function reachInvitation() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}>
    <MemoryRouter><SetupPage /></MemoryRouter>
  </QueryClientProvider>);
  fireEvent.change(await screen.findByLabelText('setup.tokenLabel'), { target: { value: 'test-token' } });
  expect(usage.status).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'setup.continue' }));
  fireEvent.change(await screen.findByLabelText('setup.emailLabel'), { target: { value: 'owner@example.test' } });
  fireEvent.change(screen.getByLabelText('setup.passwordLabel'), { target: { value: 'Review-test-password1' } });
  fireEvent.change(screen.getByLabelText('setup.confirmLabel'), { target: { value: 'Review-test-password1' } });
  fireEvent.click(screen.getByRole('button', { name: 'setup.submit' }));
  fireEvent.click(await screen.findByRole('button', { name: 'setup.usageSkip' }));
  fireEvent.click(await screen.findByText('Finish event types'));
  fireEvent.click(await screen.findByText('Finish configuration'));
  await waitFor(() => expect(usage.status).toHaveBeenCalled());
  return screen.getByRole('button', { name: 'productUsage.review' });
}

it('uses the full settings disclosure and configured collector before accepting fresh consent', async () => {
  const review = await reachInvitation();
  await waitFor(() => expect(review).toBeEnabled());
  expect(usage.enable).not.toHaveBeenCalled();
  fireEvent.click(review);
  let dialog = within(screen.getByRole('dialog'));
  for (const key of ['fields', 'visibility', 'deletion', 'versionDisclosure', 'catalogTitle']) {
    expect(dialog.getByText(`productUsage.${key}`)).toBeInTheDocument();
  }
  expect(dialog.getByRole('link', { name: 'productUsage.linkCollector' })).toHaveAttribute('href', 'https://custom-collector.example.test');
  expect(dialog.getByRole('button', { name: 'productUsage.enable' })).toBeDisabled();
  fireEvent.click(dialog.getByRole('checkbox'));
  fireEvent.click(dialog.getByRole('button', { name: 'productUsage.cancel' }));
  expect(usage.enable).not.toHaveBeenCalled();
  fireEvent.click(review);
  dialog = within(screen.getByRole('dialog'));
  expect(dialog.getByRole('checkbox')).not.toBeChecked();
  fireEvent.click(dialog.getByRole('checkbox'));
  fireEvent.click(dialog.getByRole('button', { name: 'productUsage.enable' }));
  await screen.findByText('setup.community.mission');
  expect(usage.enable).toHaveBeenCalledTimes(1);
  expect(client.getQueryData(['productUsage'])).toMatchObject({ status: 'active' });
});

it('skipping the invitation never enables reporting', async () => {
  await reachInvitation();
  fireEvent.click(screen.getByRole('button', { name: 'setup.usageReporting.skip' }));
  await screen.findByText('setup.community.mission');
  expect(usage.enable).not.toHaveBeenCalled();
  expect(usage.promptSeen).toHaveBeenCalledTimes(1);
  expect(client.getQueryData(['productUsage'])).toMatchObject({ status: 'disabled', prompt_shown: true });
});

it.each(['failed', 'invalid'])('keeps setup usable when collector configuration is %s', async (failure) => {
  if (failure === 'failed') vi.mocked(usage.status).mockRejectedValue(new Error('Status unavailable'));
  else vi.mocked(usage.status).mockResolvedValue({ status: 'disabled', collector_url: null, collector_error: 'INVALID_COLLECTOR_URL' } as never);
  const review = await reachInvitation();
  await screen.findByRole('alert');
  expect(review).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'setup.usageReporting.skip' }));
  await screen.findByText('setup.community.mission');
  expect(usage.enable).not.toHaveBeenCalled();
});

it('an enable failure cannot prevent finishing setup', async () => {
  vi.mocked(usage.enable).mockRejectedValue(new Error('Enable unavailable'));
  const review = await reachInvitation();
  await waitFor(() => expect(review).toBeEnabled());
  fireEvent.click(review);
  const dialog = within(screen.getByRole('dialog'));
  fireEvent.click(dialog.getByRole('checkbox'));
  fireEvent.click(dialog.getByRole('button', { name: 'productUsage.enable' }));
  await screen.findByText('setup.community.mission');
});

it('offers the website builder as an optional feature and switches it on when ticked', async () => {
  const { featureFlagsService } = await import('../../services/featureFlags.service');
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}>
    <MemoryRouter><SetupPage /></MemoryRouter>
  </QueryClientProvider>);
  fireEvent.change(await screen.findByLabelText('setup.tokenLabel'), { target: { value: 'test-token' } });
  fireEvent.click(screen.getByRole('button', { name: 'setup.continue' }));
  fireEvent.change(await screen.findByLabelText('setup.emailLabel'), { target: { value: 'owner@example.test' } });
  fireEvent.change(screen.getByLabelText('setup.passwordLabel'), { target: { value: 'Review-test-password1' } });
  fireEvent.change(screen.getByLabelText('setup.confirmLabel'), { target: { value: 'Review-test-password1' } });
  fireEvent.click(screen.getByRole('button', { name: 'setup.submit' }));
  expect(await screen.findByText('setup.usageGroupWebsite')).toBeInTheDocument();
  expect(screen.getByText('settings.features.websiteBuilder.description')).toBeInTheDocument();
  fireEvent.click(screen.getByText('settings.features.websiteBuilder.title'));
  fireEvent.click(screen.getByRole('button', { name: 'setup.finish' }));
  await waitFor(() => expect(featureFlagsService.update).toHaveBeenCalledWith(expect.objectContaining({ websiteBuilder: true })));
});
