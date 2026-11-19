import { guestsService } from '../services/guests.service';
import { DownloadIdentityCancelledError, readErrorBody } from './downloadLimit';

// Guest identity before downloading (issue 2503). A gallery in guest identity
// mode can ask guests for their name before any download. The server enforces
// it: a download without a guest identity answers 403 with this code. This
// module is the UX layer on top: it opens the guest prompt before a download
// starts, and again when the server refuses one.
//
// A module-level registry, as utils/downloadLimit.ts keeps its limited
// galleries: the download transports live in galleryService and in
// ArchiveDownloadProvider, which sits above the gallery's
// GuestIdentityProvider, so neither can reach the prompt through context.

export const GUEST_IDENTITY_REQUIRED_CODE = 'GUEST_IDENTITY_REQUIRED';

export interface DownloadIdentityGate {
  /** The gallery asks before every download. */
  required: boolean;
  /** Resolves once the visitor is identified; rejects when they cancel. */
  ensure: () => Promise<void>;
  /** Drop an identity the server no longer accepts, so ensure() asks again. */
  forget: () => void;
}

const gates = new Map<string, DownloadIdentityGate>();

/** Registered by GuestIdentityProvider in guest identity mode; null removes it. */
export function setDownloadIdentityGate(slug: string, gate: DownloadIdentityGate | null): void {
  if (gate) gates.set(slug, gate);
  else gates.delete(slug);
}

export const isDownloadIdentityRequired = (slug: string): boolean => !!gates.get(slug)?.required;

// The cancellation error lives in downloadLimit.ts, next to the other
// refusals callers stay silent about.
export { isDownloadIdentityCancelled } from './downloadLimit';

// The ticket route refusing a guest token the server no longer accepts.
class StaleGuestIdentityError extends Error {}

async function isIdentityRefusal(error: unknown): Promise<boolean> {
  if (error instanceof StaleGuestIdentityError) return true;
  const response = (error as { response?: { status?: number; data?: unknown } })?.response;
  if (!response || response.status !== 403) return false;
  const body = await readErrorBody(response.data);
  return body?.code === GUEST_IDENTITY_REQUIRED_CODE;
}

async function ensureOrCancel(gate: DownloadIdentityGate): Promise<void> {
  try {
    await gate.ensure();
  } catch {
    throw new DownloadIdentityCancelledError();
  }
}

/** Ask for the guest's name now, if this gallery wants it before downloads. */
export async function ensureDownloadIdentity(slug: string): Promise<void> {
  const gate = gates.get(slug);
  if (gate?.required) await ensureOrCancel(gate);
}

/**
 * Run a download on a gallery. Where the gallery asks for the guest's name
 * first, the prompt opens before the download starts; a guest already
 * identified is not asked again. A server refusal for a missing identity (the
 * setting was switched on after the page loaded, or the guest was removed
 * meanwhile) opens the prompt too, and the download is tried once more.
 * Cancelling the prompt rejects with a DownloadIdentityCancelledError.
 */
export async function withDownloadIdentity<T>(slug: string, run: () => Promise<T>): Promise<T> {
  await ensureDownloadIdentity(slug);
  try {
    return await run();
  } catch (error) {
    const gate = gates.get(slug);
    if (!gate || !(await isIdentityRefusal(error))) throw error;
    gate.forget();
    await ensureOrCancel(gate);
    return run();
  }
}

/**
 * A download URL the browser navigates to, with a download ticket naming the
 * guest when the gallery asks for one. Such a navigation carries the gallery
 * cookie but not the guest token header.
 */
export async function withGuestTicket(slug: string, url: string): Promise<string> {
  if (!isDownloadIdentityRequired(slug)) return url;
  let ticket: string;
  try {
    ticket = await guestsService.getDownloadTicket(slug);
  } catch (error) {
    const status = (error as { response?: { status?: number } })?.response?.status;
    if (status === 401) throw new StaleGuestIdentityError('Guest identity no longer accepted');
    throw error;
  }
  return `${url}${url.includes('?') ? '&' : '?'}guest_ticket=${encodeURIComponent(ticket)}`;
}
