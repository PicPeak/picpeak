/** Translate only the new mail network-policy codes; keep existing errors intact. */
export function mailPolicyError(error: unknown, translate: (key: string) => string): string | undefined {
  return mailPolicyMessage((error as { response?: { data?: { code?: unknown } } } | null)?.response?.data?.code, translate);
}

/** The same translation for a bare code (the queue processor's lastErrorCode). */
export function mailPolicyMessage(code: unknown, translate: (key: string) => string): string | undefined {
  if (code === 'MAIL_HOST_FORBIDDEN') return translate('email.networkPolicyForbidden');
  if (code === 'MAIL_HOST_UNRESOLVED') return translate('email.networkPolicyUnresolved');
  if (code === 'MAIL_CONFIG_INVALID') return translate('email.networkPolicyInvalid');
  return undefined;
}
