/**
 * The pre-send review (#1445): shows what the send will freeze and deliver,
 * blocks the send while an error stands, says what the button does, and
 * previews the signing page at phone width with the signing page's own
 * component.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', async () => ({
  ...(await vi.importActual<typeof import('react-i18next')>('react-i18next')),
  useTranslation: () => ({
    t: (_k: string, fb?: unknown, opts?: Record<string, unknown>) => {
      const base = typeof fb === 'string' ? fb : _k;
      return opts ? base.replace(/\{\{(\w+)\}\}/g, (_m, key) => String(opts[key] ?? '')) : base;
    },
    i18n: { language: 'en' },
  }),
}));

const sendPreview = vi.fn();
vi.mock('../../../../services/contracts.service', () => ({
  contractsService: { sendPreview: (...args: unknown[]) => sendPreview(...args) },
}));

import { SendReviewModal } from '../SendReviewModal';

const review = (problems: unknown[] = []) => ({
  content: {
    contractNumber: 'C-2026-0007', language: 'en', title: 'Wedding contract', introText: 'Hello', outroText: null,
    recipient: { displayName: 'Anna Muster', companyName: null, email: 'anna@example.com' },
    sections: [{ section: 'scope', blocks: [{ blockId: 1, section: 'scope', position: 1, name: 'Scope', body: 'Photos all day.' }] }],
    commercial: null,
  },
  signingOrder: 'sequential',
  signers: [
    { position: 1, role: 'customer', name: 'Anna Muster', email: 'anna@example.com' },
    { position: 2, role: 'customer', name: 'Ben Muster', email: 'ben@example.com' },
    { position: 3, role: 'issuer', name: 'Studio', email: null },
  ],
  attachments: [{ attachmentId: 4, name: 'Terms', delivery: 'merged', pages: 2, sha256: 'a'.repeat(64), ok: true }],
  totals: { currency: 'CHF', netMinor: 200000, vatRatePercent: 8.1, vatMinor: 16200, shippingMinor: 0, grossMinor: 216200 },
  template: { id: 2, name: 'Wedding', version: 3 },
  problems,
  reviewToken: 'b'.repeat(64),
});

function renderModal(onSend = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SendReviewModal contractId={7} onClose={vi.fn()} onSend={onSend} onPreviewPdf={vi.fn()} sending={false} />
    </QueryClientProvider>,
  );
  return onSend;
}

it('shows signers, attachments, price and template, and says who the send goes to', async () => {
  const user = userEvent.setup();
  sendPreview.mockResolvedValue(review());
  const onSend = renderModal();
  const dialog = await screen.findByRole('dialog', { name: 'Review before sending' });
  await screen.findByText('Everything is ready to send.');
  expect(dialog).toHaveTextContent('One after the other, in this order');
  expect(dialog).toHaveTextContent('Ben Muster · ben@example.com');
  expect(dialog).toHaveTextContent('Terms');
  expect(dialog).toHaveTextContent('Wedding, version 3');
  expect(dialog).toHaveTextContent(/Total.*2.162.00/);
  await user.click(screen.getByRole('button', { name: 'Send to 2 signers' }));
  expect(onSend).toHaveBeenCalledWith('b'.repeat(64));
});

it('an error blocks the send; a warning does not', async () => {
  sendPreview.mockResolvedValue(review([
    { code: 'ATTACHMENT_CHANGED', severity: 'error', message: '"Terms" changed', attachmentId: 4 },
  ]));
  renderModal();
  expect(await screen.findByText("This contract can't be sent yet")).toBeInTheDocument();
  expect(screen.getByText('"Terms" changed')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Send to 2 signers' })).toBeDisabled();
});

it('previews the signing page with its own component, at phone width on request', async () => {
  const user = userEvent.setup();
  sendPreview.mockResolvedValue(review([{ code: 'NO_CLAUSES', severity: 'warning', message: 'no clauses' }]));
  renderModal();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send to 2 signers' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Show the signing page' }));
  expect(screen.getByText('Photos all day.')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Phone' }));
  expect(screen.getByTestId('send-review-layout-frame')).toHaveStyle({ width: '390px' });
});
