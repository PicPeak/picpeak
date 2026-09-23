/**
 * Public → contract signing, signatures v2 (#1446). Hits
 * /api/public/contract-signing/*.
 *
 * A signer opens their own link, confirms their email with a six-digit code
 * and gets a session token. Every later call sends that token in the
 * `X-Signing-Session` header — so the PDF and attachments are fetched as
 * blobs rather than plain links.
 *
 * Contracts sent before v2 answer the invite call with 404
 * SIGNING_LINK_INVALID and keep using publicContractsService.
 */
import { api } from '../config/api';
import type { ContractStatus, PublicContractView } from './contracts.service';

const BASE = '/public/contract-signing';
const SESSION_HEADER = 'X-Signing-Session';

export type SigningInviteSignerStatus = 'pending' | 'invited' | 'signed' | 'declined';
export type SignerProgressStatus = 'pending' | 'signed' | 'declined';
export type SignatureMode = 'drawn' | 'typed';

export interface SigningIssuerSummary {
  companyName: string | null;
  logoUrl: string | null;
  logoUrlDark: string | null;
}

/** What an unverified link shows: enough to recognise it, nothing about the customer (nor the contract number). */
export interface SigningInvite {
  status: ContractStatus;
  language: string;
  issuer: SigningIssuerSummary | null;
  signer: { status: SigningInviteSignerStatus; maskedEmail: string };
}

export interface SigningSession {
  sessionToken: string;
  expiresAt: string;
}

export interface SigningProgressEntry {
  position: number;
  role: 'customer' | 'issuer';
  name: string;
  status: SignerProgressStatus;
}

export interface SigningState {
  name: string;
  email: string;
  status: 'invited' | 'signed' | 'declined' | 'pending';
  verifiedVia: 'otp' | 'portal';
  order: 'parallel' | 'sequential';
  canSign: boolean;
  waitingForOthers: boolean;
  canDecline: boolean;
  signers: SigningProgressEntry[];
}

/** A declaration frozen into the contract at send, in its language (#1446). */
export interface SigningConsent {
  key: string;
  required: boolean;
  version: number;
  text: string;
}

export interface SigningSessionContract extends PublicContractView {
  attachments: Array<{ id: number; name: string; delivery: 'merged' | 'separate'; pages: number }>;
  allowPdfUpload: boolean;
  requireDrawnSignature: boolean;
  signing: SigningState;
  /** sha256 of the content frozen at send (#1446). */
  contentSha256?: string | null;
  /** Every attachment as recorded at send, with its own hash (#1446). */
  manifest?: {
    sha256: string | null;
    attachments: Array<{ attachmentId: number; name: string; delivery: 'merged' | 'separate'; pages: number; sha256: string }>;
  };
  /** The declarations to confirm; null for a contract sent before they were frozen. */
  consents?: SigningConsent[] | null;
  /** The legal notice frozen with the contract; null for one sent before (#1446). */
  legalNotice?: string | null;
  /** Only while the contract collects the customer's details first (#1446). */
  dataRequest?: SigningDataRequest;
}

/** The details asked for before the contract is prepared (#1446). */
export interface SigningDataRequest {
  fields: string[];
  required: string[];
  values: Record<string, string>;
  submitted: boolean;
}

export interface SignPayload {
  name: string;
  mode: SignatureMode;
  signatureDataUrl?: string | null;
  /** Contracts sent before declarations were frozen: the single confirmation. */
  accepted?: true;
  /** Each frozen declaration and whether it was confirmed (#1446). */
  consents?: Array<{ key: string; accepted: boolean }>;
  idempotencyKey: string;
}

function sessionHeaders(sessionToken: string) {
  return { headers: { [SESSION_HEADER]: sessionToken } };
}

export const publicContractSigningService = {
  async invite(token: string): Promise<SigningInvite> {
    const { data } = await api.get(`${BASE}/invite/${token}`);
    return data.data || data;
  },

  /** The email goes out through the queue and can take up to a minute. */
  async requestCode(token: string): Promise<{ maskedEmail: string; ttlMinutes: number; resendAfterSeconds: number }> {
    const { data } = await api.post(`${BASE}/invite/${token}/code`);
    return data.data || data;
  },

  async verify(token: string, code: string): Promise<SigningSession> {
    const { data } = await api.post(`${BASE}/invite/${token}/verify`, { code });
    return data.data || data;
  },

  async session(sessionToken: string): Promise<{ contract: SigningSessionContract }> {
    const { data } = await api.get(`${BASE}/session`, sessionHeaders(sessionToken));
    return data.data || data;
  },

  /** The contract PDF as it stands (signed copy once someone has signed). */
  async pdf(sessionToken: string): Promise<Blob> {
    const res = await api.get(`${BASE}/session/pdf`, { ...sessionHeaders(sessionToken), responseType: 'blob' });
    return res.data;
  },

  async attachment(sessionToken: string, attachmentId: number): Promise<Blob> {
    const res = await api.get(`${BASE}/session/attachments/${attachmentId}`, {
      ...sessionHeaders(sessionToken),
      responseType: 'blob',
    });
    return res.data;
  },

  async sign(sessionToken: string, payload: SignPayload): Promise<{ status: 'sent' | 'signed_by_customer'; signedAt: string }> {
    const { data } = await api.post(`${BASE}/session/sign`, payload, sessionHeaders(sessionToken));
    return data.data || data;
  },

  /** The customer's details; the contract is prepared with them (#1446). */
  async submitDetails(sessionToken: string, values: Record<string, string>): Promise<{ status: 'sent' | 'awaiting_data'; frozen: boolean }> {
    const { data } = await api.post(`${BASE}/session/details`, { values }, sessionHeaders(sessionToken));
    return data.data || data;
  },

  async decline(sessionToken: string, reason?: string): Promise<{ status: 'declined' }> {
    const { data } = await api.post(
      `${BASE}/session/decline`,
      reason ? { reason } : {},
      sessionHeaders(sessionToken),
    );
    return data.data || data;
  },

  async uploadSignedPdf(sessionToken: string, file: File): Promise<{ status: ContractStatus }> {
    const form = new FormData();
    form.append('file', file);
    const { data } = await api.post(`${BASE}/session/upload-signed-pdf`, form, sessionHeaders(sessionToken));
    return data.data || data;
  },
};

// ---------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------

interface HttpErrorShape {
  response?: { status?: number; data?: { code?: unknown; error?: unknown } };
}

export function signingErrorStatus(err: unknown): number | undefined {
  return (err as HttpErrorShape)?.response?.status;
}

export function signingErrorCode(err: unknown): string | undefined {
  const code = (err as HttpErrorShape)?.response?.data?.code;
  return typeof code === 'string' ? code : undefined;
}

/** A 401 from a session call: the session ended, verify again. */
export function isSessionInvalid(err: unknown): boolean {
  return signingErrorStatus(err) === 401;
}

// ---------------------------------------------------------------------
// Session storage — one session per link (or one for the portal), kept
// for the tab's lifetime so a reload stays verified until it expires.
// ---------------------------------------------------------------------

/** The scope a portal session is stored under (no link token). */
export const PORTAL_SIGNING_SCOPE = 'portal';

const sessionKey = (scope: string) => `picpeak.contractSigning.session.${scope}`;
const idempotencyStorageKey = (scope: string) => `picpeak.contractSigning.idempotency.${scope}`;
const draftKey = (scope: string) => `picpeak.contractSigning.draft.${scope}`;

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export const signingSessionStore = {
  read(scope: string): SigningSession | null {
    const store = storage();
    if (!store) return null;
    try {
      const raw = store.getItem(sessionKey(scope));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<SigningSession>;
      if (typeof parsed.sessionToken !== 'string' || !parsed.sessionToken) return null;
      const expires = parsed.expiresAt ? new Date(parsed.expiresAt).getTime() : NaN;
      if (Number.isFinite(expires) && expires <= Date.now()) {
        store.removeItem(sessionKey(scope));
        return null;
      }
      return { sessionToken: parsed.sessionToken, expiresAt: String(parsed.expiresAt || '') };
    } catch {
      return null;
    }
  },

  write(scope: string, session: SigningSession): void {
    try {
      storage()?.setItem(sessionKey(scope), JSON.stringify({
        sessionToken: session.sessionToken,
        expiresAt: session.expiresAt,
      }));
    } catch { /* storage full or blocked: the session still works for this page view */ }
  },

  clear(scope: string): void {
    try {
      storage()?.removeItem(sessionKey(scope));
    } catch { /* nothing to clear */ }
  },
};

export interface SigningDraft {
  name: string;
  mode: SignatureMode;
}

/**
 * What the signer typed, kept for the tab so a reload — or a failed
 * submission that re-renders the page — doesn't make them type it again.
 *
 * The typed name and the chosen mode only. A DRAWN signature stays in
 * memory: it is the signature itself, and it has no business sitting in a
 * shared-machine browser store after the tab that drew it moved on.
 */
export const signingDraftStore = {
  read(scope: string): SigningDraft | null {
    try {
      const raw = storage()?.getItem(draftKey(scope));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<SigningDraft>;
      if (typeof parsed.name !== 'string') return null;
      return { name: parsed.name, mode: parsed.mode === 'typed' ? 'typed' : 'drawn' };
    } catch {
      return null;
    }
  },

  write(scope: string, draft: SigningDraft): void {
    try {
      storage()?.setItem(draftKey(scope), JSON.stringify(draft));
    } catch { /* storage full or blocked: the form still works for this page view */ }
  },

  clear(scope: string): void {
    try {
      storage()?.removeItem(draftKey(scope));
    } catch { /* nothing to clear */ }
  },
};

function randomKey(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * One idempotency key per link, generated once and kept for the tab. A
 * retry after a lost response sends the same key, and the server answers
 * with the signature it already recorded instead of "already signed".
 */
export function signingIdempotencyKey(scope: string): string {
  const store = storage();
  try {
    const existing = store?.getItem(idempotencyStorageKey(scope));
    if (existing) return existing;
  } catch { /* fall through to a fresh key */ }
  const key = randomKey();
  try {
    store?.setItem(idempotencyStorageKey(scope), key);
  } catch { /* the key still covers retries from this page view */ }
  return key;
}

/** Save a blob under a file name (object URL + a temporary link). */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
