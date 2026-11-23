/**
 * Event codes (issue 2495): the short code a guest types on /code. Mirrors
 * backend/src/services/eventAccessCode.js, which stays the authority.
 */
import { buildShareLinkUrl } from './url';

// No 0/O, 1/I/L: nothing a guest can misread off a printed card.
export const EVENT_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const EVENT_CODE_MIN_LENGTH = 6;
export const EVENT_CODE_MAX_LENGTH = 12;

const CODE_RE = new RegExp(`^[${EVENT_CODE_ALPHABET}]{${EVENT_CODE_MIN_LENGTH},${EVENT_CODE_MAX_LENGTH}}$`);

/** What was typed, as stored: uppercase, `-` and spaces dropped. */
export function normalizeEventCode(input: string | null | undefined): string {
  return (input || '').replace(/[\s-]+/g, '').toUpperCase();
}

export function isValidEventCode(code: string): boolean {
  return CODE_RE.test(code);
}

/** Display form: a 6-character code in two groups (K7M-4QX); other lengths as they are. */
export function formatEventCode(code: string | null | undefined): string {
  if (!code) return '';
  return code.length === 6 ? `${code.slice(0, 3)}-${code.slice(3)}` : code;
}

/** The entry page URL that opens a gallery with its code filled in, on the share link's base (`usePublicBaseUrl()`). */
export function eventCodeUrl(code: string, publicBase?: string | null): string {
  return buildShareLinkUrl(`/code/${code}`, publicBase);
}

/** Leaves the entry page for a gallery with a full document load (see EventCodePage). */
export function openGalleryDocument(path: string): void {
  window.location.replace(path);
}
