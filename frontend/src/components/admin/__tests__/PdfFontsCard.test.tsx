/**
 * Uploaded PDF fonts (#1445): the upload needs the regular face, a name, a
 * licence note and the confirmation; the server's refusal is shown in words.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', async () => ({
  ...(await vi.importActual<typeof import('react-i18next')>('react-i18next')),
  useTranslation: () => ({ t: (_k: string, fb?: unknown) => (typeof fb === 'string' ? fb : _k), i18n: { language: 'en' } }),
}));
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../PermissionGate', () => ({ PermissionGate: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

const fonts = vi.fn();
const uploadFont = vi.fn();
vi.mock('../../../services/pdfThemes.service', () => ({
  pdfThemesService: {
    fonts: (...a: unknown[]) => fonts(...a),
    uploadFont: (...a: unknown[]) => uploadFont(...a),
    archiveFont: vi.fn(),
  },
}));

import { PdfFontsCard } from '../PdfFontsCard';

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><PdfFontsCard /></QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  fonts.mockResolvedValue({
    fonts: [{ id: 1, family: 'upload-1', name: 'Brand Sans', licenceNote: 'OFL', licenceAcknowledgedAt: 'x', isActive: true, createdAt: '', files: [{ style: '400', sha256: 'a', bytes: 1 }, { style: '700', sha256: 'b', bytes: 1 }] }],
  });
});

it('lists the fonts and uploads only with a face, a name, a licence note and the confirmation', async () => {
  const user = userEvent.setup();
  uploadFont.mockResolvedValue({ font: {} });
  renderCard();
  expect(await screen.findByText('Brand Sans')).toBeInTheDocument();
  expect(screen.getByText('Regular · Bold')).toBeInTheDocument();

  const submit = screen.getByRole('button', { name: 'Add font' });
  const file = new File([new Uint8Array([0, 1, 0, 0])], 'brand.ttf', { type: 'font/ttf' });
  await user.upload(screen.getByLabelText(/Regular/), file);
  await user.type(screen.getByLabelText(/^Name/), 'Brand Serif');
  await user.type(screen.getByLabelText(/^Licence/), 'OFL 1.1');
  expect(submit).toBeDisabled();
  await user.click(screen.getByRole('checkbox', { name: /right to embed/ }));
  expect(submit).toBeEnabled();
  await user.click(submit);
  await waitFor(() => expect(uploadFont).toHaveBeenCalledWith(expect.objectContaining({
    name: 'Brand Serif', licenceNote: 'OFL 1.1', regular: file,
  })));
});

it('shows why the server refused a file', async () => {
  const user = userEvent.setup();
  uploadFont.mockRejectedValue({ response: { data: { code: 'FONT_LICENCE_RESTRICTED', error: 'restricted' } } });
  renderCard();
  await screen.findByText('Brand Sans');
  await user.upload(screen.getByLabelText(/Regular/), new File([new Uint8Array([1])], 'x.ttf'));
  await user.type(screen.getByLabelText(/^Name/), 'X');
  await user.type(screen.getByLabelText(/^Licence/), 'Y');
  await user.click(screen.getByRole('checkbox', { name: /right to embed/ }));
  await user.click(screen.getByRole('button', { name: 'Add font' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('restricted');
});
