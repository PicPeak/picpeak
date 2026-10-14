import type React from 'react';

/**
 * True while the key belongs to an IME composition (Japanese, Chinese,
 * Korean input). Escape then cancels the composition and Enter commits it:
 * both are the field's, not a shortcut to close a dialog or submit. Safari
 * ends the composition before the keydown, so only keyCode 229 tells it
 * apart there.
 */
export function isImeComposing(e: KeyboardEvent | React.KeyboardEvent): boolean {
  const native = 'nativeEvent' in e ? e.nativeEvent : e;
  return native.isComposing || native.keyCode === 229;
}
