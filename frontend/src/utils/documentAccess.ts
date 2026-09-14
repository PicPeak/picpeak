/**
 * Access grants for the public contract and quote pages.
 *
 * The emailed link alone no longer shows the customer's personal data: the
 * page asks for a one-time code sent to the customer's address, and the server
 * answers a correct code with a short-lived grant. The grant rides on every
 * request for that document as the `X-Document-Access` header.
 *
 * Kept in sessionStorage per document link, so a reload inside the tab does not
 * ask for another code but closing the tab does. Storage can be unavailable
 * (private browsing, blocked site data), so every access is guarded; without
 * storage the grant still lives in page state for the current visit.
 */
export type DocumentKind = 'contract' | 'quote';

export const DOCUMENT_ACCESS_HEADER = 'X-Document-Access';

/** Answer to "email me a code". */
export interface DocumentVerificationSent {
  sent: boolean;
  emailHint: string | null;
  resendAfterSeconds: number;
}

/** Answer to a correct code. */
export interface DocumentAccessGrant {
  grant: string;
  expiresInSeconds: number;
}

interface StoredGrant {
  grant: string;
  expiresAt: number;
}

const storageKey = (kind: DocumentKind, token: string) => `docAccess:${kind}:${token}`;

export function clearDocumentGrant(kind: DocumentKind, token: string): void {
  try {
    window.sessionStorage.removeItem(storageKey(kind, token));
  } catch {
    // Nothing could have been stored either.
  }
}

/** The stored grant for this link, or null when there is none or it ran out. */
export function readDocumentGrant(kind: DocumentKind, token: string): string | null {
  try {
    const raw = window.sessionStorage.getItem(storageKey(kind, token));
    if (!raw) return null;
    const stored = JSON.parse(raw) as Partial<StoredGrant>;
    if (typeof stored.grant !== 'string' || typeof stored.expiresAt !== 'number' || stored.expiresAt <= Date.now()) {
      clearDocumentGrant(kind, token);
      return null;
    }
    return stored.grant;
  } catch {
    return null;
  }
}

export function storeDocumentGrant(kind: DocumentKind, token: string, access: DocumentAccessGrant): void {
  try {
    const value: StoredGrant = {
      grant: access.grant,
      expiresAt: Date.now() + Math.max(0, Number(access.expiresInSeconds) || 0) * 1000,
    };
    window.sessionStorage.setItem(storageKey(kind, token), JSON.stringify(value));
  } catch {
    // Storage unavailable: the caller keeps the grant in state for this visit.
  }
}

/** Request headers carrying the grant, or undefined when there is none. */
export function documentAccessHeaders(grant?: string | null): Record<string, string> | undefined {
  return grant ? { [DOCUMENT_ACCESS_HEADER]: grant } : undefined;
}

const readBlobText = (blob: Blob): Promise<string> => (typeof blob.text === 'function'
  ? blob.text()
  : new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  }));

/**
 * A request made with `responseType: 'blob'` gets its error body as a Blob
 * too, so `isVerificationRequired` cannot read the code in it. Swap a small
 * JSON error body for the parsed object; anything else stays as it is.
 */
export async function decodeBlobErrorBody(err: unknown): Promise<void> {
  const response = (err as { response?: { data?: unknown } } | null)?.response;
  const body = response?.data;
  if (!response || typeof Blob === 'undefined' || !(body instanceof Blob) || body.size > 64 * 1024) return;
  try {
    response.data = JSON.parse(await readBlobText(body));
  } catch {
    // Not JSON: leave the body alone.
  }
}

/** True when the server refused a document request for want of a valid grant. */
export function isVerificationRequired(err: unknown): boolean {
  const response = (err as { response?: { status?: number; data?: { code?: unknown } } } | null)?.response;
  return response?.status === 401 && response.data?.code === 'VERIFICATION_REQUIRED';
}
