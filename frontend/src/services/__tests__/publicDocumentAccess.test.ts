/**
 * The public contract and quote services send the access grant as
 * `X-Document-Access` on every document request, and the portal services use
 * the session routes without any link token.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }));

import { api } from '../../config/api';
import { publicContractsService } from '../contracts.service';
import { publicQuotesService } from '../quotes.service';
import { customerService } from '../customer.service';

const get = vi.mocked(api.get);
const post = vi.mocked(api.post);
const ACCESS = { headers: { 'X-Document-Access': 'grant-1' } };

describe('public document services', () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    get.mockResolvedValue({ data: {} });
    post.mockResolvedValue({ data: {} });
  });

  it('sends no grant header before verification, and the grant after', async () => {
    await publicContractsService.get('tok', null);
    await publicContractsService.get('tok', 'grant-1');

    expect(get).toHaveBeenNthCalledWith(1, '/public/contracts/tok', { headers: undefined });
    expect(get).toHaveBeenNthCalledWith(2, '/public/contracts/tok', ACCESS);
  });

  it('asks for and confirms the emailed code', async () => {
    await publicContractsService.requestVerification('tok');
    await publicContractsService.confirmVerification('tok', '123456');
    await publicQuotesService.requestVerification('qtok');
    await publicQuotesService.confirmVerification('qtok', '654321');

    expect(post).toHaveBeenCalledWith('/public/contracts/tok/verification');
    expect(post).toHaveBeenCalledWith('/public/contracts/tok/verification/confirm', { code: '123456' });
    expect(post).toHaveBeenCalledWith('/public/quotes/qtok/verification');
    expect(post).toHaveBeenCalledWith('/public/quotes/qtok/verification/confirm', { code: '654321' });
  });

  it('carries the grant on sign, upload, PDF download and quote response', async () => {
    const payload = { name: 'Kim', signatureDataUrl: null, accepted: true as const };
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:pdf');
    get.mockResolvedValue({ data: new Blob(['%PDF']) });

    await publicContractsService.sign('tok', payload, 'grant-1');
    await publicContractsService.uploadSignedPdf('tok', new File(['x'], 'signed.pdf'), 'grant-1');
    await publicContractsService.pdfUrl('tok', 'grant-1');
    await publicQuotesService.respond('qtok', 'decline', { tosAccepted: false }, 'grant-1');

    expect(post).toHaveBeenCalledWith('/public/contracts/tok/sign', payload, ACCESS);
    expect(post).toHaveBeenCalledWith('/public/contracts/tok/upload-signed-pdf', expect.any(FormData), {
      headers: { 'Content-Type': 'multipart/form-data', 'X-Document-Access': 'grant-1' },
    });
    expect(get).toHaveBeenCalledWith('/public/contracts/tok/pdf', { responseType: 'blob', ...ACCESS });
    expect(post).toHaveBeenCalledWith('/public/quotes/qtok/respond', { action: 'decline', tosAccepted: false }, ACCESS);
  });

  it('uses the portal session routes for portal documents, with no token', async () => {
    await customerService.getContract(5);
    await customerService.signContract(5, { name: 'Kim', signatureDataUrl: null, accepted: true });
    await customerService.getQuote(9);
    await customerService.respondToQuote(9, 'accept', { tosAccepted: true });

    expect(get).toHaveBeenCalledWith('/customer/contracts/5');
    expect(post).toHaveBeenCalledWith('/customer/contracts/5/sign', { name: 'Kim', signatureDataUrl: null, accepted: true });
    expect(get).toHaveBeenCalledWith('/customer/quotes/9');
    expect(post).toHaveBeenCalledWith('/customer/quotes/9/respond', { action: 'accept', tosAccepted: true });
  });
});
