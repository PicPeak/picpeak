/**
 * Admin → Customer accounts management (#354).
 *
 * Mounted at /admin/customers. Listed in AdminSidebar gated on
 * `customers.view` so only super_admin / admin see it.
 *
 * NOT a duplicate of UserManagementPage:
 *   - admin_users table        (admin RBAC, token type 'admin', /admin/login)
 *   - customer_accounts table  (per-event access, token type 'customer', /customer/login)
 *
 * The two pages share visual patterns (tabbed list + invite modal) but
 * operate on completely different DB tables, services, auth surfaces,
 * and permission models. The customer invite intentionally has no role
 * picker (customers don't have roles — access is boolean per event,
 * managed via the event form's CustomerAccountPicker).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  UserPlus, UserCog, Trash2, Search, X, AlertTriangle, CheckCircle2, Clock, MailCheck,
} from 'lucide-react';
import { InlineCustomerCreate } from '../../components/admin/InlineCustomerCreate';
import { CustomerGroupChipList, CustomerGroupFilter } from '../../components/admin/CustomerGroupChips';
import { CustomerGroupsPanel } from '../../components/admin/CustomerGroupsPanel';
import { BulkGroupAssignModal } from '../../components/admin/BulkGroupAssignModal';
import { useMutationWithToast } from '../../hooks';
import { usePermissions } from '../../contexts/PermissionsContext';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';

import { Button, Card, Input, Loading } from '../../components/common';
import {
  customerAdminService,
  BULK_GROUP_MAX_CUSTOMERS,
  type CustomerAccountSummary,
  type CustomerGroupMatch,
  type CustomerInvitationSummary,
  type CustomerStatusFilter,
} from '../../services/customerAdmin.service';

type TabType = 'customers' | 'invitations' | 'groups';
const TABS: TabType[] = ['customers', 'invitations', 'groups'];
const STATUSES: CustomerStatusFilter[] = ['all', 'active', 'inactive'];

/**
 * An email address that may wrap only after "@" and ".": a <wbr> follows
 * each, so a narrow cell breaks "sofia.romano@example.com" into readable
 * parts instead of in the middle of a word.
 */
const breakableEmail = (email: string) => email.split(/(?<=[@.])/).map((part, index) => (
  <React.Fragment key={index}>{index > 0 && <wbr />}{part}</React.Fragment>
));

/** `groups=1,2` → [1, 2]; anything that isn't a positive integer is dropped. */
const parseIds = (value: string | null) => [...new Set((value || '').split(',')
  .map((id) => Number(id.trim()))
  .filter((id) => Number.isInteger(id) && id > 0))];

export const CustomerManagementPage: React.FC = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  // formatDate respects the admin-configured `general_date_format`
  // (DD.MM.YYYY by default) instead of the date-fns long-form 'PP'
  // (which always rendered "May 8, 2026" regardless of the setting).
  const { format: fmtDate } = useLocalizedDate();
  const formatDate = (iso: string | null | undefined) => {
    if (!iso) return '—';
    try { return fmtDate(new Date(iso)); } catch { return '—'; }
  };
  // The whole filter model lives in the URL (#1443), so a filtered overview
  // survives a reload and can be pasted to another admin: `tab`, `q`,
  // `groups=1,2`, `match=all` (left out for any), `ungrouped=1` and `status`.
  // Allowlisted on the way in; defaults are left out on the way out.
  const [searchParams, setSearchParams] = useSearchParams();
  const updateParams = useCallback((patch: Record<string, string | null>, replace = false) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === '') next.delete(key);
        else next.set(key, value);
      }
      return next;
    }, { replace });
  }, [setSearchParams]);

  const tabParam = searchParams.get('tab') as TabType | null;
  const activeTab: TabType = tabParam && TABS.includes(tabParam) ? tabParam : 'customers';
  const setActiveTab = (tab: TabType) => updateParams({ tab: tab === 'customers' ? null : tab });
  const statusParam = searchParams.get('status') as CustomerStatusFilter | null;
  const statusFilter: CustomerStatusFilter = statusParam && STATUSES.includes(statusParam) ? statusParam : 'all';
  const groupMatch: CustomerGroupMatch = searchParams.get('match') === 'all' ? 'all' : 'any';
  const ungroupedFilter = searchParams.get('ungrouped') === '1';
  const groupsParam = searchParams.get('groups');
  const groupFilter = useMemo(() => parseIds(groupsParam), [groupsParam]);

  // `searchTerm` is the live controlled-input value (keeps the box
  // responsive). It reaches the URL — and with it the filter — 250ms after
  // the admin pauses typing, replacing the history entry rather than adding
  // one per keystroke. Filtering is client-side over the fetched list.
  const debouncedTerm = searchParams.get('q') || '';
  const [searchTerm, setSearchTerm] = useState(debouncedTerm);
  // The last `q` this box wrote. A `q` that differs from it came from outside
  // — Back/Forward, a pasted link — and replaces what the box shows; our own
  // write echoing back is ignored, so text typed after it isn't clobbered.
  const writtenTerm = useRef(debouncedTerm);
  useEffect(() => {
    if (debouncedTerm === writtenTerm.current) return;
    writtenTerm.current = debouncedTerm;
    setSearchTerm(debouncedTerm);
  }, [debouncedTerm]);
  useEffect(() => {
    if (searchTerm === debouncedTerm) return undefined;
    const handle = window.setTimeout(() => {
      writtenTerm.current = searchTerm;
      updateParams({ q: searchTerm }, true);
    }, 250);
    return () => window.clearTimeout(handle);
  }, [searchTerm, debouncedTerm, updateParams]);
  // Single state drives the unified create/invite modal. Both header
  // buttons open the SAME modal (InlineCustomerCreate) — only the
  // mode-specific action button is rendered inside, so the admin's
  // choice between "create passive" and "invite" is locked in by
  // which trigger they clicked but the form fields stay identical.
  // `null` = closed.
  const [createMode, setCreateMode] = useState<'passive' | 'invite' | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'deactivate'; id: number; name: string } | { kind: 'cancelInvite'; id: number; email: string } | null>(null);

  const { hasPermission } = usePermissions();

  const { data: catalogue, isError: catalogueFailed } = useQuery({
    queryKey: ['admin-customer-groups', 'with-counts'],
    queryFn: () => customerAdminService.listGroupCatalogue(true),
  });
  const groups = catalogue?.groups;
  // Archived groups stay visible on the customers that carry them, but are
  // not offered as a filter: nothing new lands in them.
  const filterableGroups = useMemo(() => (groups || []).filter((g) => !g.isArchived), [groups]);
  // Only what the filter still offers. A selected group that was archived or
  // deleted on the Groups tab (or a stale bookmark) would otherwise keep
  // filtering the list with no pill left to switch it off.
  const activeGroupFilter = useMemo(
    () => (groups ? groupFilter.filter((id) => filterableGroups.some((g) => g.id === id)) : groupFilter),
    [groups, groupFilter, filterableGroups],
  );
  // …and the URL follows, so a reload or a copied link doesn't bring it back.
  useEffect(() => {
    if (activeGroupFilter.length !== groupFilter.length) {
      updateParams({ groups: activeGroupFilter.join(','), match: activeGroupFilter.length >= 2 ? searchParams.get('match') : null }, true);
    }
  }, [activeGroupFilter, groupFilter, updateParams, searchParams]);

  const listFilter = useMemo(() => ({
    groupIds: ungroupedFilter ? [] : activeGroupFilter,
    groupMatch,
    ungrouped: ungroupedFilter,
    status: statusFilter,
  }), [activeGroupFilter, groupMatch, ungroupedFilter, statusFilter]);
  const hasServerFilter = listFilter.ungrouped || listFilter.groupIds.length > 0 || listFilter.status !== 'all';
  const hasAnyFilter = hasServerFilter || debouncedTerm.trim() !== '';

  const toggleGroup = (id: number) => {
    const next = activeGroupFilter.includes(id)
      ? activeGroupFilter.filter((value) => value !== id)
      : [...activeGroupFilter, id];
    updateParams({ groups: next.join(','), ungrouped: null, match: next.length >= 2 ? searchParams.get('match') : null });
  };
  const clearFilters = () => {
    writtenTerm.current = '';
    setSearchTerm('');
    updateParams({ q: null, groups: null, match: null, ungrouped: null, status: null });
  };

  // `customersStale`: while a new filter loads, the rows on screen are the
  // previous filter's, so they can't be selected for a bulk change.
  const {
    data: customers, isPending: customersLoading, error: customersError, isPlaceholderData: customersStale,
  } = useQuery({
    queryKey: ['admin-customers', listFilter],
    queryFn: () => customerAdminService.list(listFilter),
    // A group filter waits for the catalogue, so a stale id from a bookmark
    // is dropped before the first request instead of after it.
    enabled: groupFilter.length === 0 || ungroupedFilter || catalogue !== undefined || catalogueFailed,
    // Toggling a filter pill keeps the table up until the new list is in,
    // instead of swapping it for a spinner each time.
    placeholderData: keepPreviousData,
  });

  // Bulk group changes (#1443): only for customers.groups.manage. The
  // selection is of rows on screen, so it is dropped whenever the filter or
  // the search changes what is on screen.
  const canManageGroups = hasPermission('customers.groups.manage');
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [bulkMode, setBulkMode] = useState<'add' | 'remove' | null>(null);
  useEffect(() => { setSelectedIds([]); }, [listFilter, debouncedTerm]);

  const { data: invitations, isLoading: invitationsLoading, error: invitationsError } = useQuery({
    queryKey: ['admin-customer-invitations'],
    queryFn: () => customerAdminService.listInvitations(),
  });

  const filteredCustomers = useMemo(() => {
    const list = customers || [];
    if (!debouncedTerm.trim()) return list;
    const term = debouncedTerm.trim().toLowerCase();
    return list.filter((c) =>
      c.email.toLowerCase().includes(term)
      || (c.displayName || '').toLowerCase().includes(term)
      || (c.lastName || '').toLowerCase().includes(term)
      || (c.companyName || '').toLowerCase().includes(term)
    );
  }, [customers, debouncedTerm]);

  // #1261 — the "Invite customer" flow is createDirect-then-sendInvite, so a
  // customer whose second call never landed is left looking identical to one
  // the admin deliberately created as passive. Both showed only
  // "Passive — admin only", and there was nothing on this row to tell them
  // apart. Cross-reference the invitations we already fetch (the endpoint
  // returns unaccepted, unexpired ones) so an invited customer says so.
  const pendingInviteByEmail = useMemo(() => {
    const map = new Map<string, CustomerInvitationSummary>();
    for (const i of invitations || []) map.set(i.email.trim().toLowerCase(), i);
    return map;
  }, [invitations]);

  const filteredInvitations = useMemo(() => {
    const list = invitations || [];
    if (!debouncedTerm.trim()) return list;
    const term = debouncedTerm.trim().toLowerCase();
    return list.filter((i) => i.email.toLowerCase().includes(term));
  }, [invitations, debouncedTerm]);

  const visibleIds = filteredCustomers.map((c) => c.id);
  // The server takes at most this many customers in one change; above it the
  // actions are off and say why, rather than failing in the dialog.
  const overBulkCap = selectedIds.length > BULK_GROUP_MAX_CUSTOMERS;
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id));
  const toggleSelected = (id: number) => setSelectedIds((current) => (
    current.includes(id) ? current.filter((value) => value !== id) : [...current, id]
  ));

  const deactivateMutation = useMutationWithToast({
    mutationFn: (id: number) => customerAdminService.deactivate(id),
    invalidateKeys: [['admin-customers']],
    successMessage: t('customers.deactivate.success', 'Customer deactivated'),
    errorMessage: () => t('customers.deactivate.error', 'Could not deactivate customer'),
  });

  const cancelInviteMutation = useMutationWithToast({
    mutationFn: (id: number) => customerAdminService.cancelInvitation(id),
    invalidateKeys: [['admin-customer-invitations']],
    successMessage: t('customers.cancelInvitation.success', 'Invitation cancelled'),
    errorMessage: () => t('customers.cancelInvitation.error', 'Could not cancel invitation'),
  });

  const renderCustomerName = (c: CustomerAccountSummary) => {
    const display = c.displayName?.trim()
      || [c.firstName, c.lastName].filter(Boolean).join(' ').trim()
      || c.companyName?.trim();
    return display || <span className="text-neutral-500 dark:text-neutral-400 italic">{t('customers.unnamed', 'Unnamed')}</span>;
  };

  // Active / deactivated plus the passive and invitation-pending badges.
  // One block for the status column and for the phone copy under the name,
  // so a phone row can't fall behind the desktop one.
  const renderStatus = (c: CustomerAccountSummary) => (
    <div className="flex flex-col gap-1">
      {c.isActive ? (
        <span className="inline-flex items-center gap-1 text-xs" style={{ color: 'var(--color-accent)' }}>
          <CheckCircle2 className="w-3.5 h-3.5" />
          {t('customers.status.active', 'Active')}
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 text-xs text-red-600">
          <X className="w-3.5 h-3.5" />
          {t('customers.status.inactive', 'Deactivated')}
        </span>
      )}
      {/* Passive customers (no portal access). The
          status badge sits on its own line so a
          passive deactivated customer can still
          show both states clearly. */}
      {c.isPassive && (() => {
        const invite = pendingInviteByEmail.get(c.email.trim().toLowerCase());
        return invite ? (
          <span
            className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-300"
            // Deliberately describes the invitation ROW, not a
            // delivery. createInvitation inserts the row and then
            // queues the email without a transaction, so an open
            // invitation does not prove an email_queue row exists,
            // let alone that anything was delivered.
            title={t('customers.invitePending.hint',
              'An invitation link for this address is open and has not been accepted. That is not proof the email reached them — check System health if they say it never arrived.') as string}
          >
            <MailCheck className="w-3 h-3" />
            {t('customers.invitePending.badge', 'Invitation pending')}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300">
            {t('customers.passive.badge', 'Passive — admin only')}
          </span>
        );
      })()}
    </div>
  );

  const renderTabs = () => (
    <div className="flex flex-wrap gap-x-4 gap-y-1 sm:gap-x-6 border-b border-neutral-200 dark:border-neutral-700 mb-6">
      <button
        type="button"
        onClick={() => setActiveTab('customers')}
        className={`pb-3 -mb-px shrink-0 whitespace-nowrap border-b-2 text-sm font-medium ${
          activeTab === 'customers' ? 'border-accent text-accent' : 'border-transparent text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100'
        }`}
      >
        {t('customers.tabs.customers', 'Customers')}
        {customers ? <span className="ml-2 text-xs">({customers.length})</span> : null}
      </button>
      <button
        type="button"
        onClick={() => setActiveTab('invitations')}
        className={`pb-3 -mb-px shrink-0 whitespace-nowrap border-b-2 text-sm font-medium ${
          activeTab === 'invitations' ? 'border-accent text-accent' : 'border-transparent text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100'
        }`}
      >
        {t('customers.tabs.invitations', 'Invitations')}
        {invitations ? <span className="ml-2 text-xs">({invitations.length})</span> : null}
      </button>
      <button
        type="button"
        onClick={() => setActiveTab('groups')}
        className={`pb-3 -mb-px shrink-0 whitespace-nowrap border-b-2 text-sm font-medium ${
          activeTab === 'groups' ? 'border-accent text-accent' : 'border-transparent text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100'
        }`}
      >
        {t('customers.tabs.groups', 'Groups')}
        {groups ? <span className="ml-2 text-xs">({groups.filter((g) => !g.isArchived).length})</span> : null}
      </button>
    </div>
  );

  return (
    <div className="container py-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-6">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">{t('customers.pageTitle', 'Customers')}</h1>
            {/* Beta badge — Calendar/Quotes/Bills tabs in the customer
                surface are placeholders, so flag the whole feature as
                still evolving. Keeps expectations honest. */}
            <span
              className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-semibold bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
              title="Beta — feature is functional but still evolving"
            >
              {t('navigation.betaTag', 'Beta')}
            </span>
          </div>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
            {t('customers.pageSubtitle', 'Recurring customer accounts that can log in at /customer/login.')}
          </p>
        </div>
        {/* On a phone the two labels are wider than the screen side by side,
            so they stack and fill the row instead of being cut off. */}
        <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-2">
          <Button
            variant="outline"
            className="w-full sm:w-auto justify-center"
            leftIcon={<UserCog className="w-4 h-4" />}
            onClick={() => setCreateMode('passive')}
          >
            {t('customers.create.openButton', 'Create passive customer')}
          </Button>
          <Button
            variant="primary"
            className="w-full sm:w-auto justify-center"
            leftIcon={<UserPlus className="w-4 h-4" />}
            onClick={() => setCreateMode('invite')}
          >
            {t('customers.invite.button', 'Invite customer')}
          </Button>
        </div>
      </div>

      <Card padding="lg">
        {renderTabs()}

        {activeTab !== 'groups' && (
          <div className="mb-4 space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="flex-1">
                <Input
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder={t('customers.search.placeholder', 'Search by email, name, or company')}
                  leftIcon={<Search className="w-5 h-5 text-neutral-400" />}
                />
              </div>
              {activeTab === 'customers' && (
                <select
                  value={statusFilter}
                  onChange={(e) => updateParams({ status: e.target.value === 'all' ? null : e.target.value })}
                  aria-label={t('customers.statusFilter.label', 'Status')}
                  className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
                >
                  <option value="all">{t('customers.statusFilter.all', 'All statuses')}</option>
                  <option value="active">{t('customers.status.active', 'Active')}</option>
                  <option value="inactive">{t('customers.status.inactive', 'Deactivated')}</option>
                </select>
              )}
            </div>
            {activeTab === 'customers' && (
              <CustomerGroupFilter
                groups={filterableGroups}
                selectedIds={ungroupedFilter ? [] : activeGroupFilter}
                onToggle={toggleGroup}
                ungrouped={ungroupedFilter}
                ungroupedCount={catalogue?.ungroupedCount}
                hasAnyGroup={(groups || []).length > 0}
                onToggleUngrouped={() => updateParams(ungroupedFilter
                  ? { ungrouped: null }
                  : { ungrouped: '1', groups: null, match: null })}
                match={groupMatch}
                onMatchChange={(match) => updateParams({ match: match === 'all' ? 'all' : null })}
                showClear={hasAnyFilter}
                onClear={clearFilters}
              />
            )}
          </div>
        )}

        {activeTab === 'groups' ? (
          <CustomerGroupsPanel canManage={hasPermission('customers.groups.manage')} />
        ) : activeTab === 'customers' ? (
          customersLoading ? (
            <div className="flex justify-center py-8"><Loading /></div>
          ) : customersError ? (
            <div className="text-sm text-red-600 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" />
              {t('customers.loadError', 'Could not load customers')}
            </div>
          ) : filteredCustomers.length === 0 ? (
            // "Nobody matches" and "there is nobody yet" are different
            // answers: the first comes with a way back to the whole list.
            hasAnyFilter ? (
              <div className="flex flex-col items-center gap-3 text-center text-neutral-500 dark:text-neutral-400 py-12">
                <span>{t('customers.emptyFiltered', 'No customers match these filters.')}</span>
                <Button variant="outline" size="sm" onClick={clearFilters}>
                  {t('customers.clearFilters', 'Clear filters')}
                </Button>
              </div>
            ) : (
              <div className="text-center text-neutral-500 dark:text-neutral-400 py-12">
                {t('customers.empty', 'No customers yet. Click "Invite customer" to add one.')}
              </div>
            )
          ) : (
            <div>
              {canManageGroups && selectedIds.length > 0 && (
                <div
                  className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-800"
                  role="region"
                  aria-label={t('customers.groups.bulk.barLabel', 'Selected customers')}
                >
                  <span className="font-medium text-neutral-900 dark:text-neutral-100">
                    {t('customers.groups.bulk.selected', {
                      count: selectedIds.length,
                      defaultValue_one: '{{count}} selected',
                      defaultValue_other: '{{count}} selected',
                    })}
                  </span>
                  <Button size="sm" variant="outline" disabled={overBulkCap} onClick={() => setBulkMode('add')}>
                    {t('customers.groups.bulk.add', 'Add to groups…')}
                  </Button>
                  <Button size="sm" variant="outline" disabled={overBulkCap} onClick={() => setBulkMode('remove')}>
                    {t('customers.groups.bulk.remove', 'Remove from groups…')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setSelectedIds([])}>
                    {t('customers.groups.bulk.clearSelection', 'Clear selection')}
                  </Button>
                  {overBulkCap && (
                    <span className="w-full text-xs text-amber-700 dark:text-amber-400" role="status">
                      {t('customers.groups.bulk.overCap',
                        'At most {{max}} customers can be changed at once. Narrow the filter or clear some of the selection.',
                        { max: BULK_GROUP_MAX_CUSTOMERS })}
                    </span>
                  )}
                </div>
              )}
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="text-left text-neutral-500 dark:text-neutral-400">
                      {/* The email is always under the name. On a phone the row
                          is that cell alone, with the groups and the status
                          under it; below 2xl (at 1440 the card is ~760px beside
                          the sidebar and the CRM sub-navigation) Company and
                          Last login step aside and the row action is an icon,
                          so Status and the action stay in view. */}
                      <th className="px-3 py-2 font-medium">
                        {/* The selection checkbox lives in the name cell, so it
                            is there on a phone too, where the other columns
                            are hidden. */}
                        <span className="inline-flex items-center gap-2">
                          {canManageGroups && (
                            <input
                              type="checkbox"
                              checked={allVisibleSelected}
                              disabled={customersStale}
                              onChange={() => setSelectedIds(allVisibleSelected ? [] : visibleIds)}
                              aria-label={t('customers.groups.bulk.selectAll', 'Select all shown customers')}
                            />
                          )}
                          {t('customers.table.name', 'Name')}
                        </span>
                      </th>
                      <th className="hidden 2xl:table-cell px-3 py-2 font-medium">{t('customers.table.company', 'Company')}</th>
                      <th className="hidden sm:table-cell px-3 py-2 font-medium">{t('customers.table.groups', 'Groups')}</th>
                      <th className="hidden sm:table-cell px-3 py-2 font-medium">{t('customers.table.eventCount', 'Events')}</th>
                      <th className="hidden 2xl:table-cell px-3 py-2 font-medium">{t('customers.table.lastLogin', 'Last login')}</th>
                      <th className="hidden sm:table-cell px-3 py-2 font-medium">{t('customers.table.status', 'Status')}</th>
                      <th className="hidden sm:table-cell px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredCustomers.map((c) => (
                      <tr key={c.id} className="border-t border-neutral-200 dark:border-neutral-700">
                        <td className="px-3 py-3 min-w-[12rem]">
                          <span className="inline-flex items-center gap-2">
                            {canManageGroups && (
                              <input
                                type="checkbox"
                                checked={selectedIds.includes(c.id)}
                                disabled={customersStale}
                                onChange={() => toggleSelected(c.id)}
                                aria-label={t('customers.groups.bulk.selectOne', 'Select {{email}}', { email: c.email })}
                              />
                            )}
                            <Link to={`/admin/clients/accounts/${c.id}`} className="text-neutral-900 dark:text-neutral-100 hover:underline">
                              {renderCustomerName(c)}
                            </Link>
                          </span>
                          {/* The email sits under the name at every width, so no
                              column of its own takes space from Status and the
                              row action. It may break only after "@" and ".",
                              never inside a word. Below 2xl the company
                              follows it, where the Company column is hidden. */}
                          <span className="mt-0.5 block text-xs text-neutral-500 dark:text-neutral-400">
                            {breakableEmail(c.email)}
                          </span>
                          {c.companyName && (
                            <span className="block text-xs text-neutral-500 dark:text-neutral-400 2xl:hidden">{c.companyName}</span>
                          )}
                          {/* Phone only: the groups sit under the name, where the
                              Groups column is hidden. */}
                          {c.groups && c.groups.length > 0 && (
                            <span className="mt-1 flex sm:hidden">
                              <CustomerGroupChipList groups={c.groups} max={2} />
                            </span>
                          )}
                          {/* …and the status, so a phone row is name, email,
                              groups and state without scrolling sideways. */}
                          <span className="mt-1 flex sm:hidden">{renderStatus(c)}</span>
                        </td>
                        <td className="hidden 2xl:table-cell px-3 py-3 text-neutral-500 dark:text-neutral-400">{c.companyName || '—'}</td>
                        <td className="hidden sm:table-cell px-3 py-3"><CustomerGroupChipList groups={c.groups} /></td>
                        <td className="hidden sm:table-cell px-3 py-3 text-neutral-500 dark:text-neutral-400">{c.eventCount ?? 0}</td>
                        <td className="hidden 2xl:table-cell px-3 py-3 text-neutral-500 dark:text-neutral-400">{formatDate(c.lastLogin)}</td>
                        <td className="hidden sm:table-cell px-3 py-3">
                          {renderStatus(c)}
                        </td>
                        <td className="hidden sm:table-cell px-3 py-3 text-right">
                          {c.isActive && (
                            // Icon-only below 2xl, where the card is too narrow
                            // for the label beside everything else; the name
                            // and the tooltip still say what it does.
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              aria-label={t('customers.deactivate.buttonLabel', 'Deactivate {{email}}', { email: c.email })}
                              title={t('customers.deactivate.buttonLabel', 'Deactivate {{email}}', { email: c.email })}
                              onClick={() => setConfirm({ kind: 'deactivate', id: c.id, name: c.email })}
                            >
                              <Trash2 className="w-4 h-4" aria-hidden="true" />
                              <span className="ml-2 hidden 2xl:inline">{t('customers.deactivate.button', 'Deactivate')}</span>
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )
        ) : (
          invitationsLoading ? (
            <div className="flex justify-center py-8"><Loading /></div>
          ) : invitationsError ? (
            <div className="text-sm text-red-600 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" />
              {t('customers.loadInvitationsError', 'Could not load invitations')}
            </div>
          ) : filteredInvitations.length === 0 ? (
            <div className="text-center text-neutral-500 dark:text-neutral-400 py-12">
              {t('customers.invitations.empty', 'No pending invitations.')}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left text-neutral-500 dark:text-neutral-400">
                    <th className="px-3 py-2 font-medium">{t('customers.invitations.email', 'Email')}</th>
                    <th className="px-3 py-2 font-medium">{t('customers.invitations.invitedBy', 'Invited by')}</th>
                    <th className="px-3 py-2 font-medium">{t('customers.invitations.expiresAt', 'Expires')}</th>
                    <th className="px-3 py-2 font-medium">{t('customers.invitations.createdAt', 'Created')}</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredInvitations.map((inv: CustomerInvitationSummary) => (
                    <tr key={inv.id} className="border-t border-neutral-200 dark:border-neutral-700">
                      <td className="px-3 py-3 text-neutral-900 dark:text-neutral-100">{inv.email}</td>
                      <td className="px-3 py-3 text-neutral-500 dark:text-neutral-400">{inv.invitedBy || '—'}</td>
                      <td className="px-3 py-3 text-neutral-500 dark:text-neutral-400">
                        <span className="inline-flex items-center gap-1">
                          <Clock className="w-3.5 h-3.5" />
                          {formatDate(inv.expiresAt)}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-neutral-500 dark:text-neutral-400">{formatDate(inv.createdAt)}</td>
                      <td className="px-3 py-3 text-right">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          leftIcon={<X className="w-4 h-4" />}
                          onClick={() => setConfirm({ kind: 'cancelInvite', id: inv.id, email: inv.email })}
                        >
                          {t('customers.invitations.cancel', 'Cancel')}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </Card>

      {/* Unified create / invite modal. The form is identical in both
          modes — only the bottom action button differs (Save as
          passive vs. Save & send portal invitation). Both flows go
          through InlineCustomerCreate's existing
          createDirect-then-sendInvite path, so the customer row is
          materialised immediately and the "Invitations" tab refreshes
          on success to surface the pending invite in the invite case. */}
      {createMode !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
          onClick={() => setCreateMode(null)}
        >
          <div
            className="w-full max-w-2xl rounded-xl shadow-lg max-h-[90vh] overflow-y-auto bg-white dark:bg-neutral-900"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6">
              <InlineCustomerCreate
                mode={createMode}
                onCancel={() => setCreateMode(null)}
                onCreated={() => {
                  setCreateMode(null);
                  queryClient.invalidateQueries({ queryKey: ['admin-customers'] });
                  queryClient.invalidateQueries({ queryKey: ['admin-customer-invitations'] });
                }}
              />
            </div>
          </div>
        </div>
      )}

      {bulkMode && (
        <BulkGroupAssignModal
          mode={bulkMode}
          customers={filteredCustomers.filter((c) => selectedIds.includes(c.id))}
          groups={groups || []}
          onClose={() => setBulkMode(null)}
          onDone={() => { setBulkMode(null); setSelectedIds([]); }}
        />
      )}

      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
          <div className="w-full max-w-md rounded-xl shadow-lg bg-white dark:bg-neutral-900">
            <div className="p-6">
              <div className="flex items-start gap-3 mb-4">
                <AlertTriangle className="w-5 h-5 mt-0.5 text-amber-500" />
                <div>
                  <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
                    {confirm.kind === 'deactivate'
                      ? t('customers.deactivate.title', 'Deactivate customer?')
                      : t('customers.cancelInvitation.title', 'Cancel invitation?')}
                  </h2>
                  <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                    {confirm.kind === 'deactivate'
                      ? t('customers.deactivate.body',
                        'They will no longer be able to log in. You can re-invite them later.')
                      : t('customers.cancelInvitation.body',
                        'The invitation link will stop working immediately.')}
                  </p>
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={() => setConfirm(null)}>
                  {t('common.cancel', 'Cancel')}
                </Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    if (confirm.kind === 'deactivate') {
                      deactivateMutation.mutate(confirm.id);
                    } else {
                      cancelInviteMutation.mutate(confirm.id);
                    }
                    setConfirm(null);
                  }}
                  isLoading={deactivateMutation.isPending || cancelInviteMutation.isPending}
                >
                  {t('common.confirm', 'Confirm')}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CustomerManagementPage;
