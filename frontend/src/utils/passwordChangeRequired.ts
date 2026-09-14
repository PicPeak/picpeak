/**
 * Was this request refused because the signed-in admin still has to rotate a
 * temporary password? The backend answers 403 MUST_CHANGE_PASSWORD on the
 * admin API and on a gallery admin preview (`?admin_preview=1`).
 */
export function isPasswordChangeRequired(error: unknown): boolean {
  const response = (error as { response?: { status?: number; data?: { code?: string } } } | null)?.response;
  return response?.status === 403 && response.data?.code === 'MUST_CHANGE_PASSWORD';
}
