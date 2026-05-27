/**
 * CustomerAccountPicker (#354).
 *
 * Multi-select autocomplete used on the event create / edit forms to
 * assign customer accounts to an event. Anyone selected here gets
 * dashboard access + can bypass the per-event password.
 *
 * Backed by GET /api/admin/customers/search (debounced 200ms).
 * Selected values render as removable chips so the form can stay compact.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X, UserPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { customerAdminService, type CustomerAccountSummary } from '../../services/customerAdmin.service';
import { useFeatureEnabled } from '../../contexts/FeatureFlagsContext';

export interface SelectedCustomer {
  id: number;
  email: string;
  displayName: string | null;
}

interface Props {
  value: SelectedCustomer[];
  onChange: (next: SelectedCustomer[]) => void;
  disabled?: boolean;
}

const labelFor = (c: { email: string; displayName?: string | null; companyName?: string | null }) => {
  const display = c.displayName?.trim() || c.companyName?.trim();
  return display ? `${display} · ${c.email}` : c.email;
};

export const CustomerAccountPicker: React.FC<Props> = ({ value, onChange, disabled }) => {
  const { t } = useTranslation();
  // Rules of Hooks: the feature-flag gate (early-return) is moved to
  // the very end of this hook list (see end of function). The previous
  // shape did `if (!customerPortalEnabled) return null` BEFORE the
  // useState/useRef/useEffect calls below, which caused the hook count
  // to differ between renders the moment the React Query for
  // /admin/feature-flags resolved (first render: enabled=false from
  // DEFAULT_FLAGS → return null; second render: enabled=true → hooks
  // run → "Rendered more hooks than during the previous render"
  // crash). That tanked the entire /admin/events/new page through
  // the global error boundary. PR #458 reviewer flag.
  const customerPortalEnabled = useFeatureEnabled('customerPortal');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CustomerAccountSummary[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Debounced search. Aborts in-flight requests so a fast typer doesn't
  // see an old result win the race over a newer one.
  useEffect(() => {
    const term = query.trim();
    if (!term) {
      setResults([]);
      setIsSearching(false);
      return;
    }
    setIsSearching(true);
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      try {
        const rows = await customerAdminService.search(term);
        if (!cancelled) {
          // Filter out already-selected ids on the client. Cheaper than
          // round-tripping the selection state to the server.
          const selectedIds = new Set(value.map((v) => v.id));
          setResults(rows.filter((r) => !selectedIds.has(r.id)));
        }
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setIsSearching(false);
      }
    }, 200);
    return () => { cancelled = true; window.clearTimeout(handle); };
  }, [query, value]);

  // Click-outside to close. Listening on mousedown matches what the
  // existing AdminHeader notification dropdown uses.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const select = (c: CustomerAccountSummary) => {
    onChange([...value, { id: c.id, email: c.email, displayName: c.displayName }]);
    setQuery('');
    setResults([]);
    setIsOpen(false);
  };

  const remove = (id: number) => {
    onChange(value.filter((v) => v.id !== id));
  };

  const helpText = useMemo(
    () => t(
      'events.customerPicker.help',
      'Customers added here can log in at /customer/login and view this gallery without entering the per-event password.'
    ),
    [t]
  );

  // Feature-flag gate (deliberately placed AFTER all hooks — see the
  // long comment at the top of this component for why). When the
  // customerPortal flag is off the backend returns 410 on
  // /admin/customers/search anyway, but hiding the UI here keeps the
  // event form clean and removes the dangling "Customer accounts"
  // label that would otherwise appear above an empty placeholder.
  if (!customerPortalEnabled) return null;

  return (
    <div ref={containerRef} className="relative">
      <label className="block text-sm font-medium text-theme mb-1">
        {t('events.customerPicker.label', 'Customer accounts')}
      </label>
      <p className="text-xs text-muted-theme mb-2">{helpText}</p>

      {/* Selected chips */}
      {value.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {value.map((c) => (
            <span
              key={c.id}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs"
              style={{
                backgroundColor: 'var(--color-elevated, #f5f5f5)',
                color: 'var(--color-text)',
                border: '1px solid var(--color-surface-border, #e5e5e5)',
              }}
            >
              <span className="font-medium">{c.displayName?.trim() || c.email}</span>
              {c.displayName?.trim() && c.email !== c.displayName && (
                <span className="text-muted-theme">· {c.email}</span>
              )}
              {!disabled && (
                <button
                  type="button"
                  onClick={() => remove(c.id)}
                  className="ml-1 -mr-1 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 p-0.5"
                  aria-label={t('events.customerPicker.removeAria', 'Remove {{name}}', { name: c.email })}
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {/* Search input */}
      <div className="relative">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400 pointer-events-none" />
        <input
          type="text"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setIsOpen(true); }}
          onFocus={() => setIsOpen(true)}
          disabled={disabled}
          placeholder={t('events.customerPicker.placeholder', 'Search by email, name, or company')}
          className="input pl-9"
        />
      </div>

      {/* Dropdown */}
      {isOpen && query.trim() !== '' && (
        <div
          className="absolute left-0 right-0 mt-1 z-20 rounded-lg shadow-lg border max-h-72 overflow-y-auto"
          style={{
            backgroundColor: 'var(--color-surface, #ffffff)',
            borderColor: 'var(--color-surface-border, #e5e5e5)',
          }}
        >
          {isSearching ? (
            <div className="px-3 py-3 text-sm text-muted-theme">
              {t('events.customerPicker.searching', 'Searching…')}
            </div>
          ) : results.length === 0 ? (
            <div className="px-3 py-3 text-sm text-muted-theme">
              {t('events.customerPicker.noResults', 'No matches. Invite this customer from Clients → Accounts first.')}
            </div>
          ) : (
            <ul role="listbox">
              {results.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => select(r)}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-700 flex items-center gap-2"
                  >
                    <UserPlus className="w-4 h-4 text-muted-theme flex-shrink-0" />
                    <span className="flex-1 truncate">{labelFor(r)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

export default CustomerAccountPicker;
