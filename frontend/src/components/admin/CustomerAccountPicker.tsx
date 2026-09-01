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
import { usePermission } from '../../hooks/usePermission';
import { InlineCustomerCreate } from './InlineCustomerCreate';

export interface SelectedCustomer {
  id: number;
  email: string;
  displayName: string | null;
}

interface Props {
  value: SelectedCustomer[];
  onChange: (next: SelectedCustomer[]) => void;
  disabled?: boolean;
  /**
   * Event-form mode (default): this picker IS part of the customer-portal
   * feature — it assigns portal logins to a gallery, so it hides itself
   * when `customerPortal` is off and explains the password bypass.
   *
   * Pass false where the picker only needs to identify an existing
   * customer record (Accounting → "bill this to a client"). Those
   * surfaces have their own gates (`accounting` / `expenses` /
   * `incomingInvoices`) and their data path never touches the portal:
   * /admin/customers{,/search} are permission-gated, not flag-gated, and
   * POST /admin/customers explicitly creates passive, portal-less
   * customers "to attach a quote / invoice / gallery to". Callers in this
   * mode render their own field label.
   */
  portalAssignment?: boolean;
}

const labelFor = (c: { email: string; displayName?: string | null; companyName?: string | null }) => {
  const display = c.displayName?.trim() || c.companyName?.trim();
  return display ? `${display} · ${c.email}` : c.email;
};

export const CustomerAccountPicker: React.FC<Props> = ({ value, onChange, disabled, portalAssignment = true }) => {
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
  // Inline create is the ONLY way to reach POST /admin/customers on an
  // Accounting-only install: /admin/clients/accounts and the CRM editors
  // that embed InlineCustomerCreate are all feature-gated, while the
  // endpoint itself is permission-gated only and exists precisely to
  // create passive, portal-less customers. Mirror that with the
  // permission rather than a flag.
  const canCreateCustomer = usePermission('customers.create');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CustomerAccountSummary[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
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

  const created = (c: { id: number; email: string; displayName: string | null }) => {
    onChange([...value, { id: c.id, email: c.email, displayName: c.displayName }]);
    setIsCreating(false);
    setQuery('');
    setResults([]);
    setIsOpen(false);
  };

  const helpText = useMemo(
    () => t(
      'events.customerPicker.help',
      'Customers added here can log in at /customer/login and view this gallery without entering the per-event password.'
    ),
    [t]
  );

  // Feature-flag gate (deliberately placed AFTER all hooks — see the
  // long comment at the top of this component for why). Only applies to
  // the event-assignment mode: hiding the UI there keeps the event form
  // clean and removes the dangling "Customer accounts" label that would
  // otherwise appear above an empty placeholder. Non-portal call sites
  // must NOT be gated — their required customer field would render as a
  // lone label with no input at all (QA S10).
  if (portalAssignment && !customerPortalEnabled) return null;

  return (
    <div ref={containerRef} className="relative">
      {portalAssignment && (
        <>
          <label className="block text-sm font-medium text-neutral-900 dark:text-neutral-100 mb-1">
            {t('events.customerPicker.label', 'Customer accounts')}
          </label>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-2">{helpText}</p>
        </>
      )}

      {/* Selected chips */}
      {value.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {value.map((c) => (
            <span
              key={c.id}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 border border-neutral-200 dark:border-neutral-700"
            >
              <span className="font-medium">{c.displayName?.trim() || c.email}</span>
              {c.displayName?.trim() && c.email !== c.displayName && (
                <span className="text-neutral-500 dark:text-neutral-400">· {c.email}</span>
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

      {isCreating ? (
        <InlineCustomerCreate
          // With the portal off, "Save & send portal invitation" would email
          // the customer a link to a login that does not exist — offer only
          // the passive record there.
          mode={customerPortalEnabled ? 'both' : 'passive'}
          onCancel={() => setIsCreating(false)}
          onCreated={created}
        />
      ) : (
      <>
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

      {!disabled && canCreateCustomer && (
        <button
          type="button"
          onClick={() => { setIsOpen(false); setIsCreating(true); }}
          className="mt-2 inline-flex items-center gap-1 text-sm text-primary-600 dark:text-primary-400 hover:underline"
        >
          {t('customers.create.openLink', '+ Create new customer')}
        </button>
      )}

      {/* Dropdown */}
      {isOpen && query.trim() !== '' && (
        <div
          className="absolute left-0 right-0 mt-1 z-20 rounded-lg shadow-lg border max-h-72 overflow-y-auto bg-white dark:bg-neutral-900 border-neutral-200 dark:border-neutral-700"
        >
          {isSearching ? (
            <div className="px-3 py-3 text-sm text-neutral-500 dark:text-neutral-400">
              {t('events.customerPicker.searching', 'Searching…')}
            </div>
          ) : results.length === 0 ? (
            <div className="px-3 py-3 text-sm text-neutral-500 dark:text-neutral-400">
              {/* The old copy pointed at Clients → Accounts, which is
                  feature-gated and therefore unreachable on an
                  Accounting-only install. Point at the button that is
                  always right there instead. */}
              {canCreateCustomer
                ? t('events.customerPicker.noResultsCanCreate', 'No matches. Use “Create new customer” to add one.')
                : t('events.customerPicker.noResultsNoPermission', 'No matches, and your role cannot create customers. Ask an administrator to add this customer.')}
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
                    <UserPlus className="w-4 h-4 text-neutral-500 dark:text-neutral-400 flex-shrink-0" />
                    <span className="flex-1 truncate">{labelFor(r)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      </>
      )}
    </div>
  );
};

export default CustomerAccountPicker;
