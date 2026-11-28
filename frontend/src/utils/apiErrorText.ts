/** The server's message for a failed request, else the client's, else "Failed". */
export const apiErrorText = (err: unknown): string => {
  const e = err as { response?: { data?: { error?: string } }; message?: string } | null | undefined;
  return e?.response?.data?.error || e?.message || 'Failed';
};

type ApiError = { response?: { data?: { code?: string; details?: unknown } } } | null | undefined;

/** The server's machine-readable code for a failed request (`WEBSITE_REVISION_CONFLICT`, …), if it sent one. */
export const apiErrorCode = (err: unknown): string | undefined => (err as ApiError)?.response?.data?.code;

/** What the server refused, item by item, if it said. */
export const apiErrorDetails = (err: unknown): unknown => (err as ApiError)?.response?.data?.details;
