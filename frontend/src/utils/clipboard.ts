/**
 * Copy text to the clipboard, with the textarea/execCommand fallback for
 * non-HTTPS installs (the documented http://host:3000/admin setup has no
 * navigator.clipboard). Throws when the fallback copy fails.
 */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.style.position = 'fixed';
  textArea.style.left = '-999999px';
  textArea.style.top = '-999999px';
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  const successful = document.execCommand('copy');
  document.body.removeChild(textArea);
  if (!successful) {
    throw new Error('Copy failed');
  }
}
