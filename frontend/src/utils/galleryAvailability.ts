const codeOf = (error: unknown) => (error as { response?: { data?: { code?: string } } } | null)?.response?.data?.code;

/**
 * The gallery is closed for now, but the visitor's access stands: paused by
 * the studio, or (#2440) waiting for the booking's invoices to be paid. Both
 * keep the session and show a notice instead of the login.
 */
export function isGalleryTemporarilyDisabled(error: unknown): boolean {
  const code = codeOf(error);
  return code === 'GALLERY_TEMPORARILY_DISABLED' || code === 'GALLERY_AWAITING_PAYMENT';
}

/** Which notice to show for a closed gallery. */
export function galleryClosedReason(error: unknown): 'paused' | 'payment' {
  return codeOf(error) === 'GALLERY_AWAITING_PAYMENT' ? 'payment' : 'paused';
}
