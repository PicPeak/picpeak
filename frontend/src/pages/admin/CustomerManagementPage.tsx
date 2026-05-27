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
import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import {
  UserPlus, Mail, Trash2, Search, X, AlertTriangle, CheckCircle2, Clock,
} from 'lucide-react';
import { format } from 'date-fns';

import { Button, Card, Input, Loading } from '../../components/common';
import {
  customerAdminService,
  type CustomerAccountSummary,
  type CustomerInvitationSummary,
} from '../../services/customerAdmin.service';

type TabType = 'customers' | 'invitations';

const formatDate = (iso: string | null | undefined) => {
  if (!iso) return '—';
  try { return format(new Date(iso), 'PP'); } catch { return '—'; }
};

/**
 * Invite modal with optional prefill (#354 follow-up).
 *
 * Email is the only required field. Everything else is collected behind
 * a "Add contact details" toggle so a fast invite stays one-click. When
 * filled, the values are stashed on the invitation row and re-rendered
 * pre-populated on the customer's accept page (where the customer can
 * still edit before submitting).
 */
const InviteModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  onInvited: () => void;
}> = ({ isOpen, onClose, onInvited }) => {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showPrefill, setShowPrefill] = useState(false);
  const [prefill, setPrefill] = useState({
    salutation: '', first_name: '', last_name: '', display_name: '',
    phone: '', company_name: '', vat_id: '',
    address_line1: '', address_line2: '', postal_code: '', city: '', state: '', country_code: '',
  });

  const updatePrefill = (key: keyof typeof prefill, value: string) => {
    setPrefill((p) => ({ ...p, [key]: value }));
  };

  const reset = () => {
    setEmail('');
    setError(null);
    setShowPrefill(false);
    setPrefill({
      salutation: '', first_name: '', last_name: '', display_name: '',
      phone: '', company_name: '', vat_id: '',
      address_line1: '', address_line2: '', postal_code: '', city: '', state: '', country_code: '',
    });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError(t('customers.invite.invalidEmail', 'Please enter a valid email'));
      return;
    }
    setSubmitting(true);
    try {
      // Strip empty values so the backend stores `null`/nothing for fields
      // the admin didn't actually fill in. Saves a round trip through
      // the backend's sanitiser and keeps the JSON payload small.
      const cleaned: Record<string, string> = {};
      for (const [k, v] of Object.entries(prefill)) {
        const trimmed = v.trim();
        if (trimmed) cleaned[k] = trimmed;
      }
      await customerAdminService.invite(
        email.trim(),
        Object.keys(cleaned).length > 0 ? cleaned : undefined,
      );
      toast.success(t('customers.invite.success', 'Invitation sent'));
      reset();
      onInvited();
      onClose();
    } catch (e: any) {
      const msg = e?.response?.status === 409
        ? t('customers.invite.conflict', 'A customer with this email already exists or has a pending invitation.')
        : e?.response?.data?.error || t('customers.invite.error', 'Could not send invitation.');
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 py-8 overflow-y-auto">
      <div className="w-full max-w-2xl rounded-xl shadow-lg my-auto" style={{ backgroundColor: 'var(--color-surface)' }}>
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-theme">
              {t('customers.invite.title', 'Invite a customer')}
            </h2>
            <button
              type="button"
              onClick={() => { reset(); onClose(); }}
              className="p-1 rounded hover:bg-neutral-100 dark:hover:bg-neutral-700"
              aria-label={t('common.close', 'Close')}
            >
              <X className="w-5 h-5 text-muted-theme" />
            </button>
          </div>
          <p className="text-sm text-muted-theme mb-4">
            {t('customers.invite.description',
              'They\'ll receive an email with a link to set up their account. Once they\'ve accepted, you can assign them to events.')}
          </p>
          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-theme mb-1">
                {t('customers.invite.email', 'Email')} <span className="text-red-500">*</span>
              </label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                error={error || undefined}
                leftIcon={<Mail className="w-5 h-5 text-neutral-400" />}
                autoFocus
              />
            </div>

            <div className="border-t pt-4" style={{ borderColor: 'var(--color-surface-border)' }}>
              <button
                type="button"
                onClick={() => setShowPrefill((v) => !v)}
                className="text-sm font-medium hover:underline"
                style={{ color: 'var(--color-accent)' }}
              >
                {showPrefill
                  ? t('customers.invite.hidePrefill', '− Hide contact details')
                  : t('customers.invite.showPrefill', '+ Add contact details (optional)')}
              </button>
              <p className="mt-1 text-xs text-muted-theme">
                {t('customers.invite.prefillHint',
                  'Anything you fill in will be pre-populated on the customer\'s sign-up page — they can still edit it.')}
              </p>
            </div>

            {showPrefill && (
              <div className="space-y-4 pt-2">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-theme mb-1">
                      {t('customer.profile.field.salutation', 'Salutation')}
                    </label>
                    <select
                      value={prefill.salutation}
                      onChange={(e) => updatePrefill('salutation', e.target.value)}
                      className="w-full rounded-lg border px-3 h-10 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
                      style={{
                        backgroundColor: 'var(--color-surface)',
                        borderColor: 'var(--color-surface-border)',
                        color: 'var(--color-text)',
                      }}
                    >
                      <option value="">{t('customer.profile.salutation.none', '— Not specified —')}</option>
                      <option value="Herr">{t('customer.profile.salutation.herr', 'Mr.')}</option>
                      <option value="Frau">{t('customer.profile.salutation.frau', 'Ms.')}</option>
                      <option value="Mx">{t('customer.profile.salutation.mx', 'Mx')}</option>
                      <option value="Dr">{t('customer.profile.salutation.dr', 'Dr.')}</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-theme mb-1">
                      {t('customer.profile.field.displayName', 'Display name')}
                    </label>
                    <Input value={prefill.display_name} onChange={(e) => updatePrefill('display_name', e.target.value)} />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-theme mb-1">
                      {t('customer.profile.field.firstName', 'First name')}
                    </label>
                    <Input value={prefill.first_name} onChange={(e) => updatePrefill('first_name', e.target.value)} />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-theme mb-1">
                      {t('customer.profile.field.lastName', 'Last name')}
                    </label>
                    <Input value={prefill.last_name} onChange={(e) => updatePrefill('last_name', e.target.value)} />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-theme mb-1">
                      {t('customer.profile.field.phone', 'Phone')}
                    </label>
                    <Input value={prefill.phone} onChange={(e) => updatePrefill('phone', e.target.value)} />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-theme mb-1">
                      {t('customer.profile.field.companyName', 'Company name')}
                    </label>
                    <Input value={prefill.company_name} onChange={(e) => updatePrefill('company_name', e.target.value)} />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-theme mb-1">
                      {t('customer.profile.field.vatId', 'VAT ID')}
                    </label>
                    <Input value={prefill.vat_id} onChange={(e) => updatePrefill('vat_id', e.target.value)} />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-6 gap-3">
                  <div className="sm:col-span-6">
                    <label className="block text-sm font-medium text-theme mb-1">
                      {t('customer.profile.field.addressLine1', 'Address line 1')}
                    </label>
                    <Input value={prefill.address_line1} onChange={(e) => updatePrefill('address_line1', e.target.value)} />
                  </div>
                  <div className="sm:col-span-6">
                    <label className="block text-sm font-medium text-theme mb-1">
                      {t('customer.profile.field.addressLine2', 'Address line 2')}
                    </label>
                    <Input value={prefill.address_line2} onChange={(e) => updatePrefill('address_line2', e.target.value)} />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-sm font-medium text-theme mb-1">
                      {t('customer.profile.field.postalCode', 'Postal code')}
                    </label>
                    <Input value={prefill.postal_code} onChange={(e) => updatePrefill('postal_code', e.target.value)} />
                  </div>
                  <div className="sm:col-span-3">
                    <label className="block text-sm font-medium text-theme mb-1">
                      {t('customer.profile.field.city', 'City')}
                    </label>
                    <Input value={prefill.city} onChange={(e) => updatePrefill('city', e.target.value)} />
                  </div>
                  <div className="sm:col-span-1">
                    <label className="block text-sm font-medium text-theme mb-1">
                      {t('customer.profile.field.countryCode', 'Country')}
                    </label>
                    <Input
                      value={prefill.country_code}
                      onChange={(e) => updatePrefill('country_code', e.target.value.toUpperCase().slice(0, 2))}
                      placeholder="DE"
                      maxLength={2}
                    />
                  </div>
                  <div className="sm:col-span-3">
                    <label className="block text-sm font-medium text-theme mb-1">
                      {t('customer.profile.field.state', 'State / region')}
                    </label>
                    <Input value={prefill.state} onChange={(e) => updatePrefill('state', e.target.value)} />
                  </div>
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => { reset(); onClose(); }}>
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button type="submit" variant="primary" isLoading={submitting} leftIcon={<UserPlus className="w-4 h-4" />}>
                {t('customers.invite.submit', 'Send invitation')}
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

export const CustomerManagementPage: React.FC = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<TabType>('customers');
  const [searchTerm, setSearchTerm] = useState('');
  const [inviteOpen, setInviteOpen] = useState(false);
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
    if (!searchTerm.trim()) return list;
    const term = searchTerm.trim().toLowerCase();
    return list.filter((c) =>
      c.email.toLowerCase().includes(term)
      || (c.displayName || '').toLowerCase().includes(term)
      || (c.lastName || '').toLowerCase().includes(term)
      || (c.companyName || '').toLowerCase().includes(term)
    );
  }, [customers, searchTerm]);

  const filteredInvitations = useMemo(() => {
    const list = invitations || [];
    if (!searchTerm.trim()) return list;
    const term = searchTerm.trim().toLowerCase();
    return list.filter((i) => i.email.toLowerCase().includes(term));
  }, [invitations, searchTerm]);

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
    return display || <span className="text-muted-theme italic">{t('customers.unnamed', 'Unnamed')}</span>;
  };

  const renderTabs = () => (
    <div className="flex gap-6 border-b mb-6" style={{ borderColor: 'var(--color-surface-border)' }}>
      <button
        type="button"
        onClick={() => setActiveTab('customers')}
        className={`pb-3 -mb-px border-b-2 text-sm font-medium ${
          activeTab === 'customers' ? 'border-accent text-accent' : 'border-transparent text-muted-theme hover:text-theme'
        }`}
      >
        {t('customers.tabs.customers', 'Customers')}
        {customers ? <span className="ml-2 text-xs">({customers.length})</span> : null}
      </button>
      <button
        type="button"
        onClick={() => setActiveTab('invitations')}
        className={`pb-3 -mb-px border-b-2 text-sm font-medium ${
          activeTab === 'invitations' ? 'border-accent text-accent' : 'border-transparent text-muted-theme hover:text-theme'
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
            <h1 className="text-2xl font-bold text-theme">{t('customers.pageTitle', 'Customers')}</h1>
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
          <p className="text-sm text-muted-theme mt-1">
            {t('customers.pageSubtitle', 'Recurring customer accounts that can log in at /customer/login.')}
          </p>
        </div>
        <Button variant="primary" leftIcon={<UserPlus className="w-4 h-4" />} onClick={() => setInviteOpen(true)}>
          {t('customers.invite.button', 'Invite customer')}
        </Button>
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
            <div className="text-center text-muted-theme py-12">
              {t('customers.empty', 'No customers yet. Click "Invite customer" to add one.')}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-theme">
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
                    <tr key={c.id} className="border-t" style={{ borderColor: 'var(--color-surface-border)' }}>
                      <td className="px-3 py-3">
                        <Link to={`/admin/clients/accounts/${c.id}`} className="text-theme hover:underline">
                          {renderCustomerName(c)}
                        </Link>
                      </td>
                      <td className="px-3 py-3 text-muted-theme">{c.email}</td>
                      <td className="px-3 py-3 text-muted-theme">{c.companyName || '—'}</td>
                      <td className="px-3 py-3 text-muted-theme">{c.eventCount ?? 0}</td>
                      <td className="px-3 py-3 text-muted-theme">{formatDate(c.lastLogin)}</td>
                      <td className="px-3 py-3">
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
            <div className="text-center text-muted-theme py-12">
              {t('customers.invitations.empty', 'No pending invitations.')}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-theme">
                    <th className="px-3 py-2 font-medium">{t('customers.invitations.email', 'Email')}</th>
                    <th className="px-3 py-2 font-medium">{t('customers.invitations.invitedBy', 'Invited by')}</th>
                    <th className="px-3 py-2 font-medium">{t('customers.invitations.expiresAt', 'Expires')}</th>
                    <th className="px-3 py-2 font-medium">{t('customers.invitations.createdAt', 'Created')}</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredInvitations.map((inv: CustomerInvitationSummary) => (
                    <tr key={inv.id} className="border-t" style={{ borderColor: 'var(--color-surface-border)' }}>
                      <td className="px-3 py-3 text-theme">{inv.email}</td>
                      <td className="px-3 py-3 text-muted-theme">{inv.invitedBy || '—'}</td>
                      <td className="px-3 py-3 text-muted-theme">
                        <span className="inline-flex items-center gap-1">
                          <Clock className="w-3.5 h-3.5" />
                          {formatDate(inv.expiresAt)}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-muted-theme">{formatDate(inv.createdAt)}</td>
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

      <InviteModal
        isOpen={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onInvited={() => queryClient.invalidateQueries({ queryKey: ['admin-customer-invitations'] })}
      />

      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
          <div className="w-full max-w-md rounded-xl shadow-lg" style={{ backgroundColor: 'var(--color-surface)' }}>
            <div className="p-6">
              <div className="flex items-start gap-3 mb-4">
                <AlertTriangle className="w-5 h-5 mt-0.5 text-amber-500" />
                <div>
                  <h2 className="text-lg font-semibold text-theme">
                    {confirm.kind === 'deactivate'
                      ? t('customers.deactivate.title', 'Deactivate customer?')
                      : t('customers.cancelInvitation.title', 'Cancel invitation?')}
                  </h2>
                  <p className="mt-1 text-sm text-muted-theme">
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
