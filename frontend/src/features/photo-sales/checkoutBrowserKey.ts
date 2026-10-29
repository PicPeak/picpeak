const STORAGE_KEY = 'picpeak_photo_checkout_browser';
let current: string | null = null;

export function readCheckoutBrowserKey(): string | null {
  try { current = sessionStorage.getItem(STORAGE_KEY) || current; } catch { /* Storage can be disabled. */ }
  return current;
}

/** Separate from gallery credentials and never part of a provider URL. */
export function checkoutBrowserKey(): string {
  const saved = readCheckoutBrowserKey();
  if (saved && /^[0-9a-f]{64}$/.test(saved)) return saved;
  current = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  try { sessionStorage.setItem(STORAGE_KEY, current); } catch { /* The emailed purchase link remains independent of browser storage. */ }
  return current;
}
