/**
 * Classify a failed contract save for the editor's error summary (issue 1447).
 *
 * The editor used to toast whatever text came back, so an admin could not tell
 * a validation problem from a server fault, and could not tell whether a draft
 * had been created. A 4xx means the save was refused and nothing was written.
 * A 5xx does not prove that: the routes read the contract back after the write
 * committed, and a proxy can time out after the commit too. So a 5xx, like no
 * response at all, leaves the outcome unconfirmed, and the idempotency key
 * makes retrying it safe.
 */

export type SaveErrorKind =
  /** 400 VALIDATION_ERROR — `fields` lists the offending request fields. */
  | 'validation'
  /** 5xx — show a generic message and the reference id, never the body. */
  | 'server'
  /** Any other 4xx — the server's `error` is a human-readable operational message. */
  | 'rejected'
  /** No response — the request may or may not have been applied. */
  | 'unconfirmed'
  /** Thrown in the browser before a request was sent. */
  | 'local';

export interface SaveErrorView {
  kind: SaveErrorKind;
  code?: string;
  message?: string;
  requestId?: string;
  /** Normalised request fields, deduplicated, in the server's order. */
  fields: string[];
}

interface HttpLikeError {
  message?: unknown;
  isAxiosError?: unknown;
  request?: unknown;
  code?: unknown;
  response?: {
    status?: number;
    data?: {
      error?: unknown;
      code?: unknown;
      requestId?: unknown;
      details?: unknown;
    };
  };
}

/**
 * `blocks[0].position` and friends all point at the block selection, and
 * express-validator reports a header by its lowercased name.
 */
export function normalizeErrorField(field: string): string {
  if (field.toLowerCase() === 'idempotency-key') return 'Idempotency-Key';
  return /^blocks(\[|\.|$)/.test(field) ? 'blocks' : field;
}

const asString = (value: unknown): string | undefined =>
  (typeof value === 'string' && value.length > 0 ? value : undefined);

export function describeSaveError(err: unknown): SaveErrorView {
  const e = (err ?? {}) as HttpLikeError;
  const response = e.response;

  if (response) {
    const data = response.data ?? {};
    const code = asString(data.code);
    const requestId = asString(data.requestId);
    const status = response.status ?? 0;
    const details = Array.isArray(data.details) ? data.details : null;

    if (code === 'VALIDATION_ERROR' || (status === 400 && details)) {
      const fields: string[] = [];
      for (const detail of details ?? []) {
        const field = asString((detail as { field?: unknown })?.field);
        if (!field) continue;
        const normalized = normalizeErrorField(field);
        if (!fields.includes(normalized)) fields.push(normalized);
      }
      return { kind: 'validation', code, requestId, fields };
    }
    if (status >= 500) {
      return { kind: 'server', code, requestId, fields: [] };
    }
    return { kind: 'rejected', code, requestId, message: asString(data.error), fields: [] };
  }

  // axios marks transport failures; a plain Error thrown by our own code has
  // none of these and never left the browser.
  if (e.isAxiosError || e.request || asString(e.code)) {
    return { kind: 'unconfirmed', fields: [] };
  }
  return { kind: 'local', message: asString(e.message), fields: [] };
}

/**
 * A fresh key for one "create this draft" attempt.
 *
 * crypto.randomUUID only exists in secure contexts, and a self-hosted install
 * is often reached over plain http on a LAN address, where getRandomValues
 * still works.
 */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
