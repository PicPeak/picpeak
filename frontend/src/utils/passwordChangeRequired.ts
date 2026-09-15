/**
 * Was this request refused because the signed-in admin still has to rotate a
 * temporary password? The backend answers 403 MUST_CHANGE_PASSWORD on the
 * admin API and on a gallery admin preview (`?admin_preview=1`).
 */
export function isPasswordChangeRequired(error: unknown): boolean {
  const response = (error as { response?: { status?: number; data?: { code?: string } } } | null)?.response;
  return response?.status === 403 && response.data?.code === 'MUST_CHANGE_PASSWORD';
}

/**
 * Was a gallery admin preview refused because the admin session idled out?
 * The backend answers 401 SESSION_TIMEOUT, as the admin API does. It is not a
 * guest-session failure, so it must not log a guest session out.
 */
export function isAdminSessionExpired(error: unknown): boolean {
  const response = (error as { response?: { status?: number; data?: { code?: string } } } | null)?.response;
  return response?.status === 401 && response.data?.code === 'SESSION_TIMEOUT';
}
