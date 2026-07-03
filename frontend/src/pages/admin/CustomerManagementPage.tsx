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
import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import {
  UserPlus, UserCog, Trash2, Search, X, AlertTriangle, CheckCircle2, Clock,
} from 'lucide-react';
import { InlineCustomerCreate } from '../../components/admin/InlineCustomerCreate';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';

import { Button, Card, Input, Loading } from '../../components/common';
import {
  customerAdminService,
  type CustomerAccountSummary,
  type CustomerInvitationSummary,
} from '../../services/customerAdmin.service';

type TabType = 'customers' | 'invitations';

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
  const [activeTab, setActiveTab] = useState<TabType>('customers');
  // `searchTerm` is the live controlled-input value (keeps the box
  // responsive). `debouncedTerm` lags 250ms behind so the filter +
  // table re-render only fire after the user pauses typing — matches
  // the pattern used in CustomerPicker for the same reason. Filtering
  // is client-side so this doesn't change network shape; the win is
  // on the render side for installs with many rows.
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedTerm, setDebouncedTerm] = useState('');
  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedTerm(searchTerm), 250);
    return () => window.clearTimeout(handle);
  }, [searchTerm]);
  // Single state drives the unified create/invite modal. Both header
  // buttons open the SAME modal (InlineCustomerCreate) — only the
  // mode-specific action button is rendered inside, so the admin's
  // choice between "create passive" and "invite" is locked in by
  // which trigger they clicked but the form fields stay identical.
  // `null` = closed.
  const [createMode, setCreateMode] = useState<'passive' | 'invite' | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'deactivate'; id: number; name: string } | { kind: 'cancelInvite'; id: number; email: string } | null>(null);

  const { data: customers, isLoading: customersLoading, error: customersError } = useQuery({
    queryKey: ['admin-customers'],
    queryFn: () => customerAdminService.list(),
  });

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

  const filteredInvitations = useMemo(() => {
    const list = invitations || [];
    if (!debouncedTerm.trim()) return list;
    const term = debouncedTerm.trim().toLowerCase();
    return list.filter((i) => i.email.toLowerCase().includes(term));
  }, [invitations, debouncedTerm]);

  const deactivateMutation = useMutation({
    mutationFn: (id: number) => customerAdminService.deactivate(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-customers'] });
      toast.success(t('customers.deactivate.success', 'Customer deactivated'));
    },
    onError: () => toast.error(t('customers.deactivate.error', 'Could not deactivate customer')),
  });

  const cancelInviteMutation = useMutation({
    mutationFn: (id: number) => customerAdminService.cancelInvitation(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-customer-invitations'] });
      toast.success(t('customers.cancelInvitation.success', 'Invitation cancelled'));
    },
    onError: () => toast.error(t('customers.cancelInvitation.error', 'Could not cancel invitation')),
  });

  const renderCustomerName = (c: CustomerAccountSummary) => {
    const display = c.displayName?.trim()
      || [c.firstName, c.lastName].filter(Boolean).join(' ').trim()
      || c.companyName?.trim();
    return display || <span className="text-neutral-500 dark:text-neutral-400 italic">{t('customers.unnamed', 'Unnamed')}</span>;
  };

  const renderTabs = () => (
    <div className="flex gap-6 border-b border-neutral-200 dark:border-neutral-700 mb-6">
      <button
        type="button"
        onClick={() => setActiveTab('customers')}
        className={`pb-3 -mb-px border-b-2 text-sm font-medium ${
          activeTab === 'customers' ? 'border-accent text-accent' : 'border-transparent text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100'
        }`}
      >
        {t('customers.tabs.customers', 'Customers')}
        {customers ? <span className="ml-2 text-xs">({customers.length})</span> : null}
      </button>
      <button
        type="button"
        onClick={() => setActiveTab('invitations')}
        className={`pb-3 -mb-px border-b-2 text-sm font-medium ${
          activeTab === 'invitations' ? 'border-accent text-accent' : 'border-transparent text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100'
        }`}
      >
        {t('customers.tabs.invitations', 'Invitations')}
        {invitations ? <span className="ml-2 text-xs">({invitations.length})</span> : null}
      </button>
    </div>
  );

  return (
    <div className="container py-6">
      <div className="flex items-center justify-between mb-6">
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
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" leftIcon={<UserCog className="w-4 h-4" />} onClick={() => setCreateMode('passive')}>
            {t('customers.create.openButton', 'Create passive customer')}
          </Button>
          <Button variant="primary" leftIcon={<UserPlus className="w-4 h-4" />} onClick={() => setCreateMode('invite')}>
            {t('customers.invite.button', 'Invite customer')}
          </Button>
        </div>
      </div>

      <Card padding="lg">
        {renderTabs()}

        <div className="mb-4">
          <Input
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder={t('customers.search.placeholder', 'Search by email, name, or company')}
            leftIcon={<Search className="w-5 h-5 text-neutral-400" />}
          />
        </div>

        {activeTab === 'customers' ? (
          customersLoading ? (
            <div className="flex justify-center py-8"><Loading /></div>
          ) : customersError ? (
            <div className="text-sm text-red-600 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" />
              {t('customers.loadError', 'Could not load customers')}
            </div>
          ) : filteredCustomers.length === 0 ? (
            <div className="text-center text-neutral-500 dark:text-neutral-400 py-12">
              {t('customers.empty', 'No customers yet. Click "Invite customer" to add one.')}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left text-neutral-500 dark:text-neutral-400">
                    <th className="px-3 py-2 font-medium">{t('customers.table.name', 'Name')}</th>
                    <th className="px-3 py-2 font-medium">{t('customers.table.email', 'Email')}</th>
                    <th className="px-3 py-2 font-medium">{t('customers.table.company', 'Company')}</th>
                    <th className="px-3 py-2 font-medium">{t('customers.table.eventCount', 'Events')}</th>
                    <th className="px-3 py-2 font-medium">{t('customers.table.lastLogin', 'Last login')}</th>
                    <th className="px-3 py-2 font-medium">{t('customers.table.status', 'Status')}</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCustomers.map((c) => (
                    <tr key={c.id} className="border-t border-neutral-200 dark:border-neutral-700">
                      <td className="px-3 py-3">
                        <Link to={`/admin/clients/accounts/${c.id}`} className="text-neutral-900 dark:text-neutral-100 hover:underline">
                          {renderCustomerName(c)}
                        </Link>
                      </td>
                      <td className="px-3 py-3 text-neutral-500 dark:text-neutral-400">{c.email}</td>
                      <td className="px-3 py-3 text-neutral-500 dark:text-neutral-400">{c.companyName || '—'}</td>
                      <td className="px-3 py-3 text-neutral-500 dark:text-neutral-400">{c.eventCount ?? 0}</td>
                      <td className="px-3 py-3 text-neutral-500 dark:text-neutral-400">{formatDate(c.lastLogin)}</td>
                      <td className="px-3 py-3">
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
                          {c.isPassive && (
                            <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300">
                              {t('customers.passive.badge', 'Passive — admin only')}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right">
                        {c.isActive && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            leftIcon={<Trash2 className="w-4 h-4" />}
                            onClick={() => setConfirm({ kind: 'deactivate', id: c.id, name: c.email })}
                          >
                            {t('customers.deactivate.button', 'Deactivate')}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
