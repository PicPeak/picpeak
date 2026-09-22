/**
 * The placeholder picker of the contract template editor (#1445): a
 * searchable list, grouped by category, of the placeholders the backend
 * allows — label, `{{key}}` and a sample value. Choosing one inserts it at
 * the caret of the text field the picker belongs to. Keyboard: the search
 * takes the focus when it opens, ↑/↓ move through the list, Enter inserts,
 * Esc closes and returns the focus to the text.
 */
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Braces } from 'lucide-react';
import { contractTemplatesService, type ContractPlaceholder } from '../../../services/contractTemplates.service';

export const PLACEHOLDER_CATEGORIES: ContractPlaceholder['category'][] = ['customer', 'event', 'contract', 'pricing', 'issuer'];
const CATEGORY_LABELS: Record<ContractPlaceholder['category'], string> = {
  customer: 'Customer', event: 'Event', contract: 'Contract', pricing: 'Pricing and terms', issuer: 'Your business',
};

/** The registry, fetched once per session. */
export function useContractPlaceholders(): ContractPlaceholder[] {
  const { data } = useQuery({
    queryKey: ['contract-template-placeholders'],
    queryFn: () => contractTemplatesService.placeholders(),
    staleTime: Infinity,
  });
  return data?.placeholders || [];
}

export const placeholderLang = (language: string | undefined): 'en' | 'de' => (language?.startsWith('de') ? 'de' : 'en');

/** Insert `text` at the caret of `el` (replacing a selection) and return the new value. */
export function insertAtCaret(el: HTMLTextAreaElement, text: string): string {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  el.setRangeText(text, start, end, 'end');
  return el.value;
}

export const PlaceholderPicker: React.FC<{
  /** The field to insert into. */
  target: React.RefObject<HTMLTextAreaElement>;
  onInsert: (value: string) => void;
  disabled?: boolean;
}> = ({ target, onInsert, disabled = false }) => {
  const { t, i18n } = useTranslation();
  const lang = placeholderLang(i18n.language);
  const placeholders = useContractPlaceholders();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const listId = useId();

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return placeholders.filter((p) => !q
      || p.key.includes(q)
      || p.label[lang].toLowerCase().includes(q)
      || p.label.en.toLowerCase().includes(q));
  }, [placeholders, query, lang]);
  // Grouped for display; `matches` keeps the keyboard order.
  const ordered = useMemo(
    () => PLACEHOLDER_CATEGORIES.flatMap((c) => matches.filter((p) => p.category === c)),
    [matches],
  );

  useEffect(() => {
    if (open) search.current?.focus();
  }, [open]);
  useEffect(() => setActive(0), [query]);

  const close = (focusText: boolean) => {
    setOpen(false);
    setQuery('');
    if (focusText && target.current) target.current.focus();
    else trigger.current?.focus();
  };

  const choose = (p: ContractPlaceholder) => {
    const el = target.current;
    if (!el) return;
    onInsert(insertAtCaret(el, `{{${p.key}}}`));
    close(true);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(ordered.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter' && ordered[active]) {
      e.preventDefault();
      choose(ordered[active]);
    }
  };

  return (
    <div className="relative inline-block">
      <button
        ref={trigger}
        type="button"
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => (open ? close(false) : setOpen(true))}
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs border border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-700 disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-600"
      >
        <Braces className="w-3.5 h-3.5" aria-hidden="true" />
        {t('contracts.templates.picker.open', 'Insert placeholder')}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={t('contracts.templates.picker.title', 'Placeholders') as string}
          className="absolute right-0 z-20 mt-1 w-80 max-w-[90vw] rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 shadow-lg p-2"
          onKeyDown={onKeyDown}
        >
          <input
            ref={search}
            type="search"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={ordered[active] ? `${listId}-${ordered[active].key}` : undefined}
            aria-label={t('contracts.templates.picker.search', 'Search placeholders') as string}
            placeholder={t('contracts.templates.picker.search', 'Search placeholders') as string}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full px-2 py-1 mb-2 rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 text-sm text-neutral-900 dark:text-neutral-100"
          />
          <div id={listId} role="listbox" className="max-h-72 overflow-y-auto">
            {ordered.length === 0 && (
              <p className="text-sm text-neutral-600 dark:text-neutral-400 px-1">{t('contracts.templates.picker.none', 'No placeholder matches.')}</p>
            )}
            {PLACEHOLDER_CATEGORIES.map((category) => {
              const inCategory = ordered.filter((p) => p.category === category);
              if (!inCategory.length) return null;
              return (
                <div key={category} role="group" aria-label={t(`contracts.templates.picker.categories.${category}`, CATEGORY_LABELS[category]) as string}>
                  <p className="text-[10px] uppercase tracking-wide text-neutral-500 dark:text-neutral-400 px-1 mt-1">
                    {t(`contracts.templates.picker.categories.${category}`, CATEGORY_LABELS[category])}
                  </p>
                  {inCategory.map((p) => {
                    const index = ordered.indexOf(p);
                    return (
                      <div
                        key={p.key}
                        id={`${listId}-${p.key}`}
                        role="option"
                        aria-selected={index === active}
                        tabIndex={-1}
                        onMouseEnter={() => setActive(index)}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => choose(p)}
                        className={`px-1 py-1 rounded cursor-pointer text-sm ${index === active ? 'bg-primary-50 dark:bg-primary-900/40' : ''}`}
                      >
                        <span className="block text-neutral-900 dark:text-neutral-100">{p.label[lang]}</span>
                        <span className="block text-xs text-neutral-600 dark:text-neutral-400">
                          <span className="font-mono">{`{{${p.key}}}`}</span>
                          {' · '}
                          {t('contracts.templates.picker.sample', 'e.g. {{value}}', { value: p.sample[lang] })}
                        </span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
