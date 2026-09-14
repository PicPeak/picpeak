/**
 * Access grants for the public contract and quote pages live in
 * sessionStorage per link. Storage can throw (private browsing, blocked site
 * data); the page must keep working and simply ask for a code again.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  clearDocumentGrant,
  documentAccessHeaders,
  isVerificationRequired,
  readDocumentGrant,
  storeDocumentGrant,
} from '../documentAccess';

afterEach(() => {
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

describe('document access grants', () => {
  it('stores a grant per document link and reads it back', () => {
    storeDocumentGrant('contract', 'tok-a', { grant: 'grant-a', expiresInSeconds: 600 });

    expect(readDocumentGrant('contract', 'tok-a')).toBe('grant-a');
    expect(readDocumentGrant('contract', 'tok-b')).toBeNull();
    expect(readDocumentGrant('quote', 'tok-a')).toBeNull();
  });

  it('drops a grant that has run out', () => {
    storeDocumentGrant('quote', 'tok', { grant: 'old', expiresInSeconds: 0 });

    expect(readDocumentGrant('quote', 'tok')).toBeNull();
    expect(window.sessionStorage.getItem('docAccess:quote:tok')).toBeNull();
  });

  it('clears a grant', () => {
    storeDocumentGrant('contract', 'tok', { grant: 'g', expiresInSeconds: 600 });
    clearDocumentGrant('contract', 'tok');

    expect(readDocumentGrant('contract', 'tok')).toBeNull();
  });

  it('survives a sessionStorage that throws', () => {
    const denied = () => { throw new Error('storage denied'); };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(denied);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(denied);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(denied);

    expect(() => storeDocumentGrant('contract', 'tok', { grant: 'g', expiresInSeconds: 600 })).not.toThrow();
    expect(readDocumentGrant('contract', 'tok')).toBeNull();
    expect(() => clearDocumentGrant('contract', 'tok')).not.toThrow();
  });

  it('builds the grant header only when there is a grant', () => {
    expect(documentAccessHeaders('g')).toEqual({ 'X-Document-Access': 'g' });
    expect(documentAccessHeaders(null)).toBeUndefined();
  });

  it('recognises a refusal for want of a grant', () => {
    expect(isVerificationRequired({ response: { status: 401, data: { code: 'VERIFICATION_REQUIRED' } } })).toBe(true);
    expect(isVerificationRequired({ response: { status: 401, data: { code: 'TOKEN_EXPIRED' } } })).toBe(false);
    expect(isVerificationRequired({ response: { status: 403, data: { code: 'VERIFICATION_REQUIRED' } } })).toBe(false);
    expect(isVerificationRequired(new Error('Network Error'))).toBe(false);
  });
});
