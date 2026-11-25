import { guestsService } from '../services/guests.service';
import { feedbackService } from '../services/feedback.service';
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
  /** No download holds the gallery anymore (holdGalleryMount). */
  idle?: () => void;
}

const gates = new Map<string, DownloadIdentityGate>();

/** Registered by GuestIdentityProvider in guest identity mode; null removes it. */
export function setDownloadIdentityGate(slug: string, gate: DownloadIdentityGate | null): void {
  if (gate) gates.set(slug, gate);
  else gates.delete(slug);
}

// A download in progress holds the gallery mounted. Replacing a refused guest
// identity mid-download rebuilds the gallery for the new guest (their likes,
// favourites and labels, not the previous guest's), but not while a download
// is still running in it: the size picker would lose its job. The rebuild
// waits until the last hold is released.
const holds = new Map<string, number>();

/** Hold the gallery mounted until the returned release is called. */
export function holdGalleryMount(slug: string): () => void {
  holds.set(slug, (holds.get(slug) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (holds.get(slug) ?? 1) - 1;
    if (left > 0) {
      holds.set(slug, left);
      return;
    }
    holds.delete(slug);
    gates.get(slug)?.idle?.();
  };
}

export const isGalleryMountHeld = (slug: string): boolean => (holds.get(slug) ?? 0) > 0;

// The cancellation error lives in downloadLimit.ts, next to the other
// refusals callers stay silent about.
export { isDownloadIdentityCancelled } from './downloadLimit';

// The download routes and the ticket route refuse a missing or stale guest
// identity with 403 GUEST_IDENTITY_REQUIRED. Any other refusal, a 401 for an
// expired gallery session above all, is not about the guest.
async function isIdentityRefusal(error: unknown): Promise<boolean> {
  const response = (error as { response?: { status?: number; data?: unknown; headers?: Record<string, unknown> } })?.response;
  if (!response || response.status !== 403) return false;
  // The HEAD preflight of a direct download gets no body; the server names
  // the refusal in a header as well.
  if (response.headers?.['x-error-code'] === GUEST_IDENTITY_REQUIRED_CODE) return true;
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
    const release = holdGalleryMount(slug);
    try {
      gate.forget();
      await ensureOrCancel(gate);
      return await run();
    } finally {
      release();
    }
  }
}

/**
 * A download URL the browser navigates to, with a download ticket naming the
 * guest when the gallery asks for one. Such a navigation carries the gallery
 * cookie but not the guest token header.
 *
 * Where the page's copy of the setting says the gallery does not ask, the
 * setting is read again first: the admin may have switched it on since the
 * page loaded, and a navigated download the server refuses lands on a bare
 * 403 page instead of the prompt. Only in guest identity mode (a gate is
 * registered); a failed read keeps the page's copy.
 */
export async function withGuestTicket(slug: string, url: string): Promise<string> {
  const gate = gates.get(slug);
  if (!gate) return url;
  if (!gate.required) {
    const settings = await feedbackService.getGalleryFeedbackSettings(slug).catch(() => null);
    if (!settings?.require_guest_for_download) return url;
    await ensureOrCancel(gate);
  }
  const ticket = await guestsService.getDownloadTicket(slug);
  return `${url}${url.includes('?') ? '&' : '?'}guest_ticket=${encodeURIComponent(ticket)}`;
}
