/**
 * Command palette (Cmd/Ctrl+K) — one keystroke to any admin page or setting.
 *
 * It indexes the sidebar and Settings from the same hooks they render from
 * (see `useAdminSearchIndex`), so it can only offer destinations this admin
 * can actually open. Record search — jump to an event, a customer, an
 * invoice — needs a backend endpoint and is deliberately not here yet; the
 * index is a plain array so an async source can be concatenated later.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Search, CornerDownLeft } from 'lucide-react';
import { searchScore } from '../../features/settings/settingsNav';
import { useLeaveGuard } from '../../contexts/UnsavedChangesContext';
import { useAdminSearchIndex, type AdminSearchEntry } from './adminSearchIndex';

const MAX_RESULTS = 12;

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const entries = useAdminSearchIndex();
  const { confirmLeave, isAnyDirty } = useLeaveGuard();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // Whatever had focus when the palette opened, so closing puts it back
  // instead of dropping the caret at the top of the document.
  const returnFocusRef = useRef<Element | null>(null);

  // Every open starts from a clean slate — a palette that reopens holding the
  // last query is a palette that navigates somewhere unexpected on Enter.
  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setCursor(0);
    returnFocusRef.current = document.activeElement;
    // The input mounts with the overlay, so focus has to wait a frame.
    const id = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(id);
      // Back to the trigger. A modal that releases focus to the top of the
      // page makes a keyboard user re-traverse the whole admin to get back.
      const back = returnFocusRef.current;
      if (back instanceof HTMLElement && document.contains(back)) back.focus();
    };
  }, [isOpen]);

  const results = useMemo(() => {
    const scored = entries
      .map((e) => ({ entry: e, score: searchScore(query, e.label, e.keywords) }))
      .filter((r) => r.score > 0);
    // Stable within a score band: the index is already in menu order, so an
    // empty query lists the admin's menu as they know it rather than shuffling.
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_RESULTS).map((r) => r.entry);
  }, [entries, query]);

  useEffect(() => { setCursor(0); }, [query]);

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${cursor}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  if (!isOpen) return null;

  const go = (entry: AdminSearchEntry | undefined) => {
    if (!entry) return;
    const after = () => { onClose(); navigate(entry.href); };
    // A settings form with unsaved edits gets the same say it has over the
    // sidebar (UnsavedChangesProvider).
    if (!isAnyDirty) { after(); return; }
    void confirmLeave().then((ok) => { if (ok) after(); });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => (results.length ? (c + 1) % results.length : 0));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => (results.length ? (c - 1 + results.length) % results.length : 0));
      return;
    }
    if (e.key === 'Enter') { e.preventDefault(); go(results[cursor]); return; }
    // Focus trap. The dialog is modal, so Tab cycles inside it rather than
    // stepping into the page underneath, which is still fully rendered.
    //
    // Only genuinely tabbable nodes count. The results are `tabIndex={-1}` on
    // purpose — this is the activedescendant pattern, where the input keeps
    // focus and `aria-activedescendant` names the active option — so a
    // selector of bare `button` collects nodes Tab can never reach. That made
    // `last` an unreachable option: forward Tab matched neither end and left
    // the dialog, and Shift+Tab parked focus on an option whose keystrokes no
    // longer reached this handler, which is bound to the input. Worse than no
    // trap at all.
    if (e.key === 'Tab') {
      const tabbable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'input:not([tabindex="-1"]), button:not([tabindex="-1"]), '
        + '[href]:not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])');
      if (!tabbable?.length) return;
      const first = tabbable[0];
      const last = tabbable[tabbable.length - 1];
      // Today that is the input alone, so Tab has nowhere to go; Escape is the
      // way out. Written as a cycle so it stays correct if the dialog ever
      // grows a second tab stop.
      if (tabbable.length === 1) { e.preventDefault(); first.focus(); return; }
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };

  // Group headings are rendered by watching the group change down the list,
  // so the ordering above stays a single flat ranking.
  let lastGroup: string | null = null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center px-4 pt-[12vh]"
      role="presentation"
      onClick={onClose}
    >
      <div className="fixed inset-0 bg-black/50" aria-hidden="true" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('search.palette.label', 'Search the admin area')}
        className="relative w-full max-w-xl rounded-xl bg-panel shadow-2xl border border-line overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 border-b border-line">
          <Search className="w-4 h-4 text-faint flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('search.palette.placeholder', 'Search pages and settings…')}
            aria-label={t('search.palette.placeholder', 'Search pages and settings…')}
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls={results.length > 0 ? 'command-palette-results' : undefined}
            aria-activedescendant={results[cursor] ? `cmdk-${results[cursor].key}` : undefined}
            autoComplete="off"
            className="flex-1 py-3 bg-transparent text-heading placeholder:text-muted focus:outline-none text-sm"
          />
          <kbd className="hidden sm:inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded border border-line text-muted">
            ESC
          </kbd>
        </div>

        {results.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted text-center">
            {t('search.palette.noResults', 'Nothing matches “{{query}}”.', { query })}
          </p>
        ) : (
          <ul
            ref={listRef}
            id="command-palette-results"
            role="listbox"
            aria-label={t('search.palette.label', 'Search the admin area')}
            className="max-h-80 overflow-y-auto py-2"
          >
            {results.map((entry, index) => {
              const showGroup = entry.group !== lastGroup;
              lastGroup = entry.group;
              const isActive = index === cursor;
              return (
                <React.Fragment key={entry.key}>
                  {showGroup && (
                    <li role="presentation" className="px-4 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
                      {entry.group}
                    </li>
                  )}
                  <li role="presentation">
                    <button
                      type="button"
                      role="option"
                      id={`cmdk-${entry.key}`}
                      aria-selected={isActive}
                      tabIndex={-1}
                      data-index={index}
                      onMouseEnter={() => setCursor(index)}
                      onClick={() => go(entry)}
                      className={`w-full flex items-center gap-3 px-4 py-2 text-left text-sm transition-colors ${
                        isActive ? 'bg-accent-dark text-white' : 'text-body hover:bg-hover-soft'
                      }`}
                    >
                      <entry.icon className={`w-4 h-4 flex-shrink-0 ${isActive ? 'text-white' : 'text-neutral-400'}`} />
                      <span className="truncate">{entry.label}</span>
                      {entry.context && (
                        <span className={`ml-auto pl-3 text-xs truncate ${isActive ? 'text-white/70' : 'text-muted'}`}>
                          {entry.context}
                        </span>
                      )}
                      {isActive && <CornerDownLeft className="w-3.5 h-3.5 flex-shrink-0 text-white/70" />}
                    </button>
                  </li>
                </React.Fragment>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
};
