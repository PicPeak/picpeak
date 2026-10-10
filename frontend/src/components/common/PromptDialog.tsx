import React, { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from './Modal';
import { Button } from './Button';

export interface PromptOptions {
  title: string;
  /** What happens, and what the text is for. */
  message?: string;
  label: string;
  defaultValue?: string;
  /** A reason or a note: a textarea instead of one line. */
  multiline?: boolean;
  /** An empty value may be confirmed ("leave blank to skip"). */
  optional?: boolean;
  confirmLabel?: string;
  variant?: 'primary' | 'danger';
}

/**
 * Ask for one value in a dialog — the replacement for window.prompt(), which
 * can't be styled, translated or tested. Resolves to the text (trimmed), or
 * null when cancelled. Render `dialog` once in the component.
 *
 *   const [dialog, prompt] = usePrompt();
 *   const reason = await prompt({ title, label, multiline: true, optional: true });
 *   if (reason === null) return;
 */
export function usePrompt(): [React.ReactNode, (options: PromptOptions) => Promise<string | null>] {
  const { t } = useTranslation();
  const [options, setOptions] = useState<PromptOptions | null>(null);
  const [value, setValue] = useState('');
  const resolver = useRef<((v: string | null) => void) | null>(null);
  const inputRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);

  const prompt = useCallback((next: PromptOptions) => new Promise<string | null>((resolve) => {
    resolver.current = resolve;
    setValue(next.defaultValue ?? '');
    setOptions(next);
  }), []);

  const settle = (result: string | null) => {
    resolver.current?.(result);
    resolver.current = null;
    setOptions(null);
  };

  const canConfirm = !!options && (options.optional || value.trim().length > 0);
  const dialog = options ? (
    <Modal
      open
      onClose={() => settle(null)}
      title={options.title}
      size="sm"
      initialFocusRef={inputRef}
      footer={(
        <>
          <Button variant="outline" onClick={() => settle(null)}>{t('common.cancel', 'Cancel')}</Button>
          <Button
            variant={options.variant === 'danger' ? 'danger' : 'primary'}
            disabled={!canConfirm}
            onClick={() => settle(value.trim())}
          >
            {options.confirmLabel ?? t('common.confirm', 'Confirm')}
          </Button>
        </>
      )}
    >
      <form
        onSubmit={(e) => { e.preventDefault(); if (canConfirm && !options.multiline) settle(value.trim()); }}
        className="space-y-3"
      >
        {options.message && <p className="text-sm text-body whitespace-pre-line">{options.message}</p>}
        <label className="block">
          <span className="block text-sm font-medium text-body mb-1">{options.label}</span>
          {options.multiline ? (
            <textarea ref={inputRef} rows={3} value={value} onChange={(e) => setValue(e.target.value)} className="input h-auto py-2" />
          ) : (
            <input ref={inputRef} value={value} onChange={(e) => setValue(e.target.value)} className="input" />
          )}
        </label>
      </form>
    </Modal>
  ) : null;

  return [dialog, prompt];
}
