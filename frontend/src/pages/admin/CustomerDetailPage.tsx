/**
 * Admin → Customer detail / edit (#354).
 *
 * Mounted at /admin/customers/:id. Editable view of every field on the
 * customer_accounts table — name, salutation, address, billing, notes —
 * so an admin can keep the record current for future quotes/invoicing
 * features. Also lists the events the customer is currently assigned to
 * (linked to the event detail page; assignments themselves are managed
 * from the event form, not here).
 */
import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import {
  ArrowLeft, Mail, MapPin, Phone, Building2, Save, Trash2, AlertTriangle,
  CheckCircle2, X, FileText, Calendar, KeyRound, ToggleLeft, Settings as SettingsIcon,
} from 'lucide-react';
import { format } from 'date-fns';

import { Button, Card, Input, Loading } from '../../components/common';
import { SUPPORTED_LANGUAGES } from '../../components/common/LanguageSelector';
import { AssignedEventsDialog } from '../../components/admin/AssignedEventsDialog';
import {
  customerAdminService,
  type CustomerAccountDetail,
} from '../../services/customerAdmin.service';

type EditableFields =
  | 'email' | 'salutation' | 'firstName' | 'lastName' | 'displayName'
  | 'phone' | 'companyName' | 'billingEmail' | 'vatId'
  | 'addressLine1' | 'addressLine2' | 'postalCode' | 'city' | 'state'
  | 'countryCode' | 'preferredLanguage' | 'notes'
  | 'featureCalendar' | 'featureQuotes' | 'featureBills';

const formatDate = (iso: string | null | undefined) => {
  if (!iso) return '—';
  try { return format(new Date(iso), 'PP'); } catch { return '—'; }
};

export const CustomerDetailPage: React.FC = () => {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const customerId = Number(id);

  const { data: customer, isLoading, error } = useQuery({
    queryKey: ['admin-customer', customerId],
    queryFn: () => customerAdminService.get(customerId),
    enabled: Number.isFinite(customerId) && customerId > 0,
  });

  const [form, setForm] = useState<Partial<Pick<CustomerAccountDetail, EditableFields>>>({});
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const [confirmErase, setConfirmErase] = useState(false);
  // Drives the "Manage galleries" modal launched from the Assigned
  // events card. We hold open-state here (rather than inside the
  // dialog) so the parent decides when to mount/unmount and the
  // dialog can hard-reset its internal state per open.
  const [assignedDialogOpen, setAssignedDialogOpen] = useState(false);

  // Hydrate the form from the fetched record once. We deliberately do NOT
  // re-sync on every refetch so an admin's in-progress edits aren't blown
  // away by a background refresh.
  useEffect(() => {
    if (customer && Object.keys(form).length === 0) {
      setForm({
        email: customer.email,
        salutation: customer.salutation,
        firstName: customer.firstName,
        lastName: customer.lastName,
        displayName: customer.displayName,
        phone: customer.phone,
        companyName: customer.companyName,
        billingEmail: customer.billingEmail,
        vatId: customer.vatId,
        addressLine1: customer.addressLine1,
        addressLine2: customer.addressLine2,
        postalCode: customer.postalCode,
        city: customer.city,
        state: customer.state,
        countryCode: customer.countryCode,
        preferredLanguage: customer.preferredLanguage,
        notes: customer.notes,
        featureCalendar: customer.featureCalendar ?? false,
        featureQuotes:   customer.featureQuotes   ?? false,
        featureBills:    customer.featureBills    ?? false,
      } as any);
    }
  }, [customer, form]);

  const toggleFeature = (key: 'featureCalendar' | 'featureQuotes' | 'featureBills') => {
    setForm((prev) => ({ ...prev, [key]: !prev[key] }) as any);
  };

  const setField = (key: EditableFields) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm((prev) => ({ ...prev, [key]: e.target.value }));

  const saveMutation = useMutation({
    mutationFn: () => customerAdminService.update(customerId, form),
    onSuccess: (updated) => {
      queryClient.setQueryData(['admin-customer', customerId], updated);
      queryClient.invalidateQueries({ queryKey: ['admin-customers'] });
      toast.success(t('customers.detail.saved', 'Customer saved'));
    },
    onError: (e: any) => {
      const msg = e?.response?.status === 409
        ? t('customers.detail.emailConflict', 'That email is already in use by another customer.')
        : e?.response?.data?.error || t('customers.detail.saveError', 'Could not save changes.');
      toast.error(msg);
    },
  });

  /**
   * Trigger a password-reset email. Reused permission `customers.create`
   * server-side because issuing a reset is the same authority level as
   * issuing an invitation (both put a credential in the customer's mailbox).
   * Confirm dialog ahead of the click is surfaced via the same modal
   * pattern as deactivate.
   */
  const passwordResetMutation = useMutation({
    mutationFn: () => customerAdminService.sendPasswordReset(customerId),
    onSuccess: () => toast.success(t('customers.detail.passwordReset.success', 'Password reset email sent')),
    onError: () => toast.error(t('customers.detail.passwordReset.error', 'Could not send password reset')),
  });

  const deactivateMutation = useMutation({
    mutationFn: () => customerAdminService.deactivate(customerId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-customer', customerId] });
      queryClient.invalidateQueries({ queryKey: ['admin-customers'] });
      toast.success(t('customers.deactivate.success', 'Customer deactivated'));
      navigate('/admin/clients/accounts');
    },
    onError: () => toast.error(t('customers.deactivate.error', 'Could not deactivate customer')),
  });

  /** Re-enable login for a deactivated customer. */
  const reactivateMutation = useMutation({
    mutationFn: () => customerAdminService.reactivate(customerId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-customer', customerId] });
      queryClient.invalidateQueries({ queryKey: ['admin-customers'] });
      toast.success(t('customers.reactivate.success', 'Customer reactivated'));
    },
    onError: () => toast.error(t('customers.reactivate.error', 'Could not reactivate customer')),
  });

  /**
   * Anonymize-in-place erasure. Two-step UX: requires the customer to be
   * deactivated first, then a separate confirm modal. Hard delete is
   * deliberately NOT exposed — see service notes for why.
   */
  const eraseMutation = useMutation({
    mutationFn: () => customerAdminService.erase(customerId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-customer', customerId] });
      queryClient.invalidateQueries({ queryKey: ['admin-customers'] });
      toast.success(t('customers.erase.success', 'Customer erased'));
      navigate('/admin/clients/accounts');
    },
    onError: () => toast.error(t('customers.erase.error', 'Could not erase customer')),
  });

  if (isLoading) {
    return <div className="flex justify-center py-16"><Loading /></div>;
  }
  if (error || !customer) {
    return (
      <div className="container py-6">
        <div className="text-sm text-red-600 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" />
          {t('customers.detail.loadError', 'Could not load customer')}
        </div>
      </div>
    );
  }

  return (
    <div className="container py-6 space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            to="/admin/clients/accounts"
            className="p-2 -ml-2 rounded hover:bg-neutral-100 dark:hover:bg-neutral-700"
            aria-label={t('common.back', 'Back')}
          >
            <ArrowLeft className="w-4 h-4 text-muted-theme" />
          </Link>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-theme truncate">
              {customer.displayName || customer.email}
            </h1>
            <p className="text-sm text-muted-theme truncate">{customer.email}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {customer.isActive ? (
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
        </div>
      </div>

      {/* Account section */}
      <Card padding="lg">
        <h2 className="text-lg font-semibold text-theme mb-4 flex items-center gap-2">
          <Mail className="w-5 h-5" /> {t('customers.detail.accountSection', 'Account')}
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-theme mb-1">{t('customers.detail.email', 'Email')}</label>
            <Input type="email" value={form.email || ''} onChange={setField('email')} />
          </div>
          <div>
            <label className="block text-sm font-medium text-theme mb-1">{t('customers.detail.preferredLanguage', 'Preferred language')}</label>
            <select
              value={form.preferredLanguage || 'en'}
              onChange={setField('preferredLanguage')}
              className="input"
            >
              {/* Drive the option list from SUPPORTED_LANGUAGES so adding a
                  locale (#510 added es; fr was already missing here) only
                  needs to touch LanguageSelector. */}
              {SUPPORTED_LANGUAGES.map((lang) => (
                <option key={lang.code} value={lang.code}>{lang.name}</option>
              ))}
            </select>
          </div>
        </div>
      </Card>

      {/* Personal section */}
      <Card padding="lg">
        <h2 className="text-lg font-semibold text-theme mb-4">
          {t('customers.detail.personalSection', 'Personal information')}
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-theme mb-1">{t('customers.detail.salutation', 'Salutation')}</label>
            {/* Salutation values are stored verbatim in the DB ("Herr",
                "Frau", "Mx", "Dr") — those are the canonical token values
                across locales. Display labels are translated; the value
                attribute stays in the German form so existing rows
                remain valid regardless of which locale the admin is
                viewing the dropdown in. */}
            <select
              value={form.salutation || ''}
              onChange={setField('salutation')}
              className="input"
            >
              <option value="">{t('customer.profile.salutation.none', '— Not specified —')}</option>
              <option value="Herr">{t('customer.profile.salutation.herr', 'Mr.')}</option>
              <option value="Frau">{t('customer.profile.salutation.frau', 'Ms.')}</option>
              <option value="Mx">{t('customer.profile.salutation.mx', 'Mx')}</option>
              <option value="Dr">{t('customer.profile.salutation.dr', 'Dr.')}</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-theme mb-1">{t('customers.detail.firstName', 'First name')}</label>
            <Input value={form.firstName || ''} onChange={setField('firstName')} />
          </div>
          <div>
            <label className="block text-sm font-medium text-theme mb-1">{t('customers.detail.lastName', 'Last name')}</label>
            <Input value={form.lastName || ''} onChange={setField('lastName')} />
          </div>
          <div>
            <label className="block text-sm font-medium text-theme mb-1">{t('customers.detail.displayName', 'Display name')}</label>
            <Input value={form.displayName || ''} onChange={setField('displayName')} />
          </div>
          <div>
            <label className="block text-sm font-medium text-theme mb-1 flex items-center gap-1">
              <Phone className="w-4 h-4" /> {t('customers.detail.phone', 'Phone')}
            </label>
            <Input value={form.phone || ''} onChange={setField('phone')} />
          </div>
          <div>
            <label className="block text-sm font-medium text-theme mb-1 flex items-center gap-1">
              <Building2 className="w-4 h-4" /> {t('customers.detail.company', 'Company')}
            </label>
            <Input value={form.companyName || ''} onChange={setField('companyName')} />
          </div>
        </div>
      </Card>

      {/* Section order rationale (follow-up reorder request): the
          customer detail page now flows from "who they are" (Personal)
          → "what we know about them" (Notes) → "what they've worked
          with us on" (Events) → "how to bill them" (Billing) → "what
          they can do in the portal" (Features) → "destructive admin
          actions" (Actions). Notes + Events promoted out from below
          billing/features because they're the surfaces admins glance
          at most when opening a customer record. */}

      {/* Notes (admin-only) */}
      <Card padding="lg">
        <h2 className="text-lg font-semibold text-theme mb-4 flex items-center gap-2">
          <FileText className="w-5 h-5" /> {t('customers.detail.notesSection', 'Internal notes')}
        </h2>
        <p className="text-xs text-muted-theme mb-3">
          {t('customers.detail.notesHint', 'Visible only to admins. Never shown to the customer.')}
        </p>
        <textarea
          value={form.notes || ''}
          onChange={setField('notes') as any}
          rows={4}
          className="input w-full"
        />
      </Card>

      {/* Assigned events */}
      <Card padding="lg">
        <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
          <h2 className="text-lg font-semibold text-theme flex items-center gap-2">
            <Calendar className="w-5 h-5" /> {t('customers.detail.eventsSection', 'Assigned events')}
          </h2>
          {/* Manage galleries: opens the multi-select dialog that
              replaces the customer's full assignment list. Disabled
              for deactivated customers because their login is off
              anyway — re-enable first if the admin wants to plan
              their access. */}
          <Button
            variant="outline"
            size="sm"
            leftIcon={<SettingsIcon className="w-4 h-4" />}
            onClick={() => setAssignedDialogOpen(true)}
            disabled={!customer.isActive}
          >
            {t('customers.detail.manageEvents', 'Manage galleries')}
          </Button>
        </div>
        {customer.events.length === 0 ? (
          <p className="text-sm text-muted-theme">
            {t('customers.detail.noEvents', 'Not assigned to any events yet. Use "Manage galleries" to add some.')}
          </p>
        ) : (
          <ul className="divide-y" style={{ borderColor: 'var(--color-surface-border)' }}>
            {customer.events.map((ev) => (
              <li key={ev.id} className="py-2 flex items-center justify-between">
                <Link to={`/admin/events/${ev.id}`} className="text-theme hover:underline">
                  {ev.eventName}
                </Link>
                <span className="text-xs text-muted-theme">
                  {ev.eventDate ? formatDate(ev.eventDate) : ''}
                  {ev.expiresAt ? ` · ${t('customers.detail.expires', 'expires')} ${formatDate(ev.expiresAt)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <AssignedEventsDialog
        customerId={customer.id}
        isOpen={assignedDialogOpen}
        initial={customer.events.map((ev) => ({
          id: ev.id,
          eventName: ev.eventName,
          eventDate: ev.eventDate || null,
        }))}
        onClose={() => setAssignedDialogOpen(false)}
        onSaved={() => {
          // Parent refetch is handled by the dialog's invalidateQueries.
        }}
      />

      {/* Address + billing */}
      <Card padding="lg">
        <h2 className="text-lg font-semibold text-theme mb-4 flex items-center gap-2">
          <MapPin className="w-5 h-5" /> {t('customers.detail.billingSection', 'Address & billing')}
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-theme mb-1">{t('customers.detail.billingEmail', 'Billing email')}</label>
            <Input type="email" value={form.billingEmail || ''} onChange={setField('billingEmail')} />
          </div>
          <div>
            <label className="block text-sm font-medium text-theme mb-1">{t('customers.detail.vatId', 'VAT / tax ID')}</label>
            <Input value={form.vatId || ''} onChange={setField('vatId')} />
          </div>
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-theme mb-1">{t('customers.detail.addressLine1', 'Address line 1')}</label>
            <Input value={form.addressLine1 || ''} onChange={setField('addressLine1')} />
          </div>
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-theme mb-1">{t('customers.detail.addressLine2', 'Address line 2')}</label>
            <Input value={form.addressLine2 || ''} onChange={setField('addressLine2')} />
          </div>
          <div>
            <label className="block text-sm font-medium text-theme mb-1">{t('customers.detail.postalCode', 'Postal code')}</label>
            <Input value={form.postalCode || ''} onChange={setField('postalCode')} />
          </div>
          <div>
            <label className="block text-sm font-medium text-theme mb-1">{t('customers.detail.city', 'City')}</label>
            <Input value={form.city || ''} onChange={setField('city')} />
          </div>
          <div>
            <label className="block text-sm font-medium text-theme mb-1">{t('customers.detail.state', 'State / region')}</label>
            <Input value={form.state || ''} onChange={setField('state')} />
          </div>
          <div>
            <label className="block text-sm font-medium text-theme mb-1">{t('customers.detail.countryCode', 'Country (ISO 2)')}</label>
            <Input
              value={form.countryCode || ''}
              onChange={setField('countryCode')}
              maxLength={2}
              placeholder="e.g. CH"
            />
          </div>
        </div>
      </Card>

      {/* Per-customer feature flags (#354 follow-up) */}
      <Card padding="lg">
        <h2 className="text-lg font-semibold text-theme mb-1 flex items-center gap-2">
          <ToggleLeft className="w-5 h-5" />
          {t('customers.detail.featuresSection', 'Customer features')}
        </h2>
        <p className="text-xs text-muted-theme mb-4">
          {t(
            'customers.detail.featuresHint',
            'Per-customer overrides for the customer-surface tabs. The global toggles in Settings → Features are the master switch — when global is OFF nobody sees the tab, regardless of what you set here. Defaults are ON, so flip a switch OFF to hide a tab for this specific customer.'
          )}
        </p>
        <div className="space-y-3">
          {([
            { key: 'featureCalendar', labelKey: 'customer.nav.calendar', fallback: 'Calendar' },
            { key: 'featureQuotes',   labelKey: 'customer.nav.quotes',   fallback: 'Quotes' },
            { key: 'featureBills',    labelKey: 'customer.nav.bills',    fallback: 'Bills' },
          ] as const).map(({ key, labelKey, fallback }) => {
            const enabled = !!form[key];
            return (
              <label key={key} className="flex items-center justify-between gap-3 cursor-pointer">
                <span className="text-sm font-medium text-theme flex items-center gap-2">
                  {t(labelKey, fallback)}
                  {/* Soon badge — these tabs are still coming-soon stubs;
                      this keeps the admin honest when looking at the
                      toggles. */}
                  <span
                    className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-semibold bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                  >
                    {t('customer.nav.soon', 'Soon')}
                  </span>
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={enabled}
                  onClick={() => toggleFeature(key)}
                  className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
                  style={{ backgroundColor: enabled ? 'var(--color-accent)' : 'var(--color-surface-border)' }}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'}`}
                  />
                </button>
              </label>
            );
          })}
        </div>
      </Card>

      {/* Account actions: password reset (#354 follow-up) */}
      <Card padding="lg">
        <h2 className="text-lg font-semibold text-theme mb-1 flex items-center gap-2">
          <KeyRound className="w-5 h-5" />
          {t('customers.detail.passwordSection', 'Account actions')}
        </h2>
        <p className="text-xs text-muted-theme mb-4">
          {t(
            'customers.detail.passwordHint',
            'Sends a 7-day single-use reset link to the customer\'s email. The customer\'s current password keeps working until they click the link and set a new one.'
          )}
        </p>
        <Button
          variant="outline"
          leftIcon={<KeyRound className="w-4 h-4" />}
          isLoading={passwordResetMutation.isPending}
          disabled={!customer.isActive}
          onClick={() => passwordResetMutation.mutate()}
        >
          {t('customers.detail.passwordReset.button', 'Send password reset email')}
        </Button>
        {!customer.isActive && (
          <p className="text-xs text-muted-theme mt-2">
            {t('customers.detail.passwordReset.inactive', 'Reactivate the customer before sending a reset.')}
          </p>
        )}
      </Card>

      {/* Actions */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          {customer.isActive ? (
            <Button
              variant="outline"
              leftIcon={<Trash2 className="w-4 h-4" />}
              onClick={() => setConfirmDeactivate(true)}
            >
              {t('customers.deactivate.button', 'Deactivate')}
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                leftIcon={<CheckCircle2 className="w-4 h-4" />}
                isLoading={reactivateMutation.isPending}
                onClick={() => reactivateMutation.mutate()}
              >
                {t('customers.reactivate.button', 'Reactivate')}
              </Button>
              {/* Erase is only offered when the customer is already
                  inactive — forces a deliberate two-step (deactivate
                  → erase) and removes the chance of misclicking through
                  the deactivate button on a live account. */}
              <Button
                variant="outline"
                leftIcon={<Trash2 className="w-4 h-4 text-red-600" />}
                onClick={() => setConfirmErase(true)}
              >
                <span className="text-red-600">
                  {t('customers.erase.button', 'Erase customer data')}
                </span>
              </Button>
            </>
          )}
        </div>
        <Button
          variant="primary"
          leftIcon={<Save className="w-4 h-4" />}
          isLoading={saveMutation.isPending}
          onClick={() => saveMutation.mutate()}
        >
          {t('customers.detail.save', 'Save changes')}
        </Button>
      </div>

      {confirmDeactivate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
          <div className="w-full max-w-md rounded-xl shadow-lg" style={{ backgroundColor: 'var(--color-surface)' }}>
            <div className="p-6">
              <div className="flex items-start gap-3 mb-4">
                <AlertTriangle className="w-5 h-5 mt-0.5 text-amber-500" />
                <div>
                  <h2 className="text-lg font-semibold text-theme">
                    {t('customers.deactivate.title', 'Deactivate customer?')}
                  </h2>
                  <p className="mt-1 text-sm text-muted-theme">
                    {t('customers.deactivate.body',
                      'They will no longer be able to log in. You can re-activate or fully erase them later.')}
                  </p>
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={() => setConfirmDeactivate(false)}>
                  {t('common.cancel', 'Cancel')}
                </Button>
                <Button
                  variant="primary"
                  isLoading={deactivateMutation.isPending}
                  onClick={() => { deactivateMutation.mutate(); setConfirmDeactivate(false); }}
                >
                  {t('common.confirm', 'Confirm')}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Erase confirm modal — second step after deactivate. Spelled out
          "irreversible" copy + red Confirm button so the click feels
          deliberate. The action anonymizes PII in place; assignments
          and audit-log references are preserved. */}
      {confirmErase && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
          <div className="w-full max-w-md rounded-xl shadow-lg" style={{ backgroundColor: 'var(--color-surface)' }}>
            <div className="p-6">
              <div className="flex items-start gap-3 mb-4">
                <AlertTriangle className="w-5 h-5 mt-0.5 text-red-600" />
                <div>
                  <h2 className="text-lg font-semibold text-theme">
                    {t('customers.erase.title', 'Erase customer data?')}
                  </h2>
                  <p className="mt-1 text-sm text-muted-theme">
                    {t('customers.erase.body',
                      'Removes the customer\'s name, email, phone, address, company and credentials. The account row stays so historical event-access records and audit logs still reference it. This is irreversible — you cannot restore the data afterwards.')}
                  </p>
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={() => setConfirmErase(false)}>
                  {t('common.cancel', 'Cancel')}
                </Button>
                <button
                  type="button"
                  className="inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-60 disabled:cursor-not-allowed"
                  disabled={eraseMutation.isPending}
                  onClick={() => { eraseMutation.mutate(); setConfirmErase(false); }}
                >
                  {eraseMutation.isPending
                    ? t('customers.erase.confirmInFlight', 'Erasing…')
                    : t('customers.erase.confirm', 'Erase permanently')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CustomerDetailPage;
