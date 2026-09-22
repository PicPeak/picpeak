import DOMPurify from 'dompurify';

/** Apply a viewer policy to old as well as newly ingested messages. A sandbox
 * stops scripts, but does not stop image/CSS tracking requests on its own. */
export function emailPreviewDocument(html: string, allowRemoteImages = false): string {
  const body = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'link', 'meta', 'base', 'form', 'input', 'button'],
  });
  const images = allowRemoteImages ? 'data: blob: https: http:' : 'data: blob:';
  const policy = `default-src 'none'; img-src ${images}; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`;
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"></head><body>${body}</body></html>`;
}
