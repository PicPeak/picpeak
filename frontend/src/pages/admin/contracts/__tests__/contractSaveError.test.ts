/**
 * Classification behind the contract editor's error summary (issue 1447).
 * Whether a response came back decides the "was my draft saved?" sentence, so
 * a transport failure must never be read as a refusal, and vice versa.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { describeSaveError, newIdempotencyKey, normalizeErrorField } from '../contractSaveError';

const http = (status: number, data: Record<string, unknown>) => ({ isAxiosError: true, request: {}, response: { status, data } });

describe('describeSaveError', () => {
  it('reads a validation error as a refusal with normalised, deduplicated fields', () => {
    const view = describeSaveError(http(400, {
      code: 'VALIDATION_ERROR',
      requestId: 'r1',
      details: [
        { field: 'blocks[0].position', message: 'Invalid value' },
        { field: 'blocks[2].blockId', message: 'Invalid value' },
        { field: 'eventDate', message: 'Invalid value' },
      ],
    }));
    expect(view).toEqual({ kind: 'validation', code: 'VALIDATION_ERROR', requestId: 'r1', fields: ['blocks', 'eventDate'] });
  });

  it('keeps a 5xx body out of the view apart from the reference id', () => {
    const view = describeSaveError(http(500, { error: 'SQLITE_ERROR: no such column', code: 'INTERNAL_ERROR', requestId: 'r2' }));
    expect(view).toEqual({ kind: 'server', code: 'INTERNAL_ERROR', requestId: 'r2', fields: [] });
  });

  it('passes an operational 4xx message through', () => {
    const view = describeSaveError(http(409, { error: 'Customer is deactivated', requestId: 'r3' }));
    expect(view).toEqual({ kind: 'rejected', code: undefined, requestId: 'r3', message: 'Customer is deactivated', fields: [] });
  });

  it('reads a transport failure as unconfirmed, not as a refusal', () => {
    expect(describeSaveError({ isAxiosError: true, request: {}, code: 'ECONNABORTED', message: 'timeout' }).kind).toBe('unconfirmed');
    expect(describeSaveError({ isAxiosError: true, request: {}, code: 'ERR_NETWORK' }).kind).toBe('unconfirmed');
  });

  it('reads an error thrown before any request as local', () => {
    expect(describeSaveError(new Error('Pick a customer first'))).toEqual({ kind: 'local', message: 'Pick a customer first', fields: [] });
  });

  it('normalises every block path to the block selection', () => {
    expect(normalizeErrorField('blocks')).toBe('blocks');
    expect(normalizeErrorField('blocks[3].included')).toBe('blocks');
    expect(normalizeErrorField('blocksExtra')).toBe('blocksExtra');
    expect(normalizeErrorField('title')).toBe('title');
  });

  it('maps the idempotency header however express-validator cases it', () => {
    expect(normalizeErrorField('idempotency-key')).toBe('Idempotency-Key');
    expect(normalizeErrorField('Idempotency-Key')).toBe('Idempotency-Key');
  });
});

describe('newIdempotencyKey', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns a key the server accepts', () => {
    expect(newIdempotencyKey()).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
  });

  it('still works where randomUUID is missing (plain http on a LAN address)', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => { bytes.fill(0xab); return bytes; },
    });
    expect(newIdempotencyKey()).toBe('ab'.repeat(16));
  });
});
