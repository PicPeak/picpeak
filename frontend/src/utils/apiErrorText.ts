/** The server's message for a failed request, else the client's, else "Failed". */
export const apiErrorText = (err: unknown): string => {
  const e = err as { response?: { data?: { error?: string } }; message?: string } | null | undefined;
  return e?.response?.data?.error || e?.message || 'Failed';
};
