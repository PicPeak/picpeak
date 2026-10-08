/**
 * TeamMemberPicker (issue 743).
 *
 * Multi-select of admin accounts for a gallery's team, built like
 * CustomerAccountPicker: chips for the selection, a search field, a dropdown.
 * An assigned admin reaches the gallery the way its owner does, within its
 * role's permissions. The account list is short and comes in one request
 * (GET /admin/events/assignable-admins), so the search filters locally.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, X, UserPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AssignedAdmin } from '../../types';
import { eventsService } from '../../services/events.service';

interface Props {
  value: AssignedAdmin[];
  onChange: (next: AssignedAdmin[]) => void;
  /** The gallery's owner, left out of the list: they reach it anyway. */
  ownerId?: number | null;
  disabled?: boolean;
}

const labelFor = (a: AssignedAdmin) => (a.role_name ? `${a.username} · ${a.role_name}` : a.username);

export const TeamMemberPicker: React.FC<Props> = ({ value, onChange, ownerId, disabled }) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const { data: admins = [], isLoading, isError } = useQuery({
    queryKey: ['assignable-admins'],
    queryFn: () => eventsService.getAssignableAdmins(),
    enabled: !disabled,
  });

  const results = useMemo(() => {
    const term = query.trim().toLowerCase();
    const selected = new Set(value.map((a) => a.id));
    return admins.filter((a) => !selected.has(a.id) && a.id !== ownerId
      && (!term || a.username.toLowerCase().includes(term) || (a.role_name || '').toLowerCase().includes(term)));
  }, [admins, query, value, ownerId]);

  // Click-outside to close, as in CustomerAccountPicker.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const select = (a: AssignedAdmin) => {
    onChange([...value, a]);
    setQuery('');
    setIsOpen(false);
  };

  return (
    <div ref={containerRef} className="relative">
      <label className="block text-sm font-medium text-heading mb-1">
        {t('events.team.label', 'Team members')}
      </label>
      <p className="text-xs text-muted mb-2">
        {t('events.team.help', 'Admin accounts added here can work on this gallery like you, within what their role allows. Customer and billing data stay yours.')}
      </p>

      {value.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {value.map((a) => (
            <span
              key={a.id}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs bg-subtle text-heading border border-line"
            >
              <span className="font-medium">{a.username}</span>
              {a.role_name && <span className="text-muted">· {a.role_name}</span>}
              {!disabled && (
                <button
                  type="button"
                  onClick={() => onChange(value.filter((v) => v.id !== a.id))}
                  className="ml-1 -mr-1 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 p-0.5"
                  aria-label={t('events.team.removeAria', 'Remove {{name}}', { name: a.username })}
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {!disabled && (
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-faint pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setIsOpen(true); }}
            onFocus={() => setIsOpen(true)}
            placeholder={t('events.team.placeholder', 'Search admin accounts')}
            className="input pl-9"
          />
        </div>
      )}

      {isOpen && !disabled && (
        <div className="absolute left-0 right-0 mt-1 z-20 rounded-lg shadow-lg border max-h-72 overflow-y-auto bg-shell border-line">
          {isLoading ? (
            <div className="px-3 py-3 text-sm text-muted">{t('events.team.loading', 'Loading…')}</div>
          ) : isError ? (
            <div className="px-3 py-3 text-sm text-red-600 dark:text-red-400">
              {t('events.team.loadFailed', 'The admin accounts could not be loaded.')}
            </div>
          ) : results.length === 0 ? (
            <div className="px-3 py-3 text-sm text-muted">{t('events.team.noResults', 'No other admin accounts match.')}</div>
          ) : (
            <ul role="listbox">
              {results.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => select(a)}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-hover flex items-center gap-2"
                  >
                    <UserPlus className="w-4 h-4 text-muted flex-shrink-0" />
                    <span className="flex-1 truncate">{labelFor(a)}</span>
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

export default TeamMemberPicker;
