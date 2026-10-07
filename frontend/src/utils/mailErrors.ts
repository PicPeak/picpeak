/** Translate only the new mail network-policy codes; keep existing errors intact. */
export function mailPolicyError(error: unknown, translate: (key: string) => string): string | undefined {
  const code = (error as { response?: { data?: { code?: unknown } } } | null)?.response?.data?.code;
  if (code === 'MAIL_HOST_FORBIDDEN') return translate('email.networkPolicyForbidden');
  if (code === 'MAIL_CONFIG_INVALID') return translate('email.networkPolicyInvalid');
  return undefined;
}
