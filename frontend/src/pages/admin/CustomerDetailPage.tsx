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
  Clock,
} from 'lucide-react';

import { Button, Card, CountrySelect, Input, Loading } from '../../components/common';
import { SUPPORTED_LANGUAGES } from '../../components/common/LanguageSelector';
import { DecimalInput } from '../../components/common/DecimalInput';
import { AssignedEventsDialog } from '../../components/admin/AssignedEventsDialog';
import {
  customerAdminService,
  type CustomerAccountDetail,
} from '../../services/customerAdmin.service';
import { businessProfileService } from '../../services/businessProfile.service';
import { CustomerCrmPanels } from '../../components/admin/CustomerCrmPanels';
import { HoursSection } from '../../components/admin/HoursSection';
import { formatMoney } from '../../components/admin/LineItemsTable';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { useFeatureFlags } from '../../contexts/FeatureFlagsContext';

type EditableFields =
  | 'email' | 'salutation' | 'firstName' | 'lastName' | 'displayName'
  | 'phone' | 'companyName' | 'billingEmail' | 'vatId'
  | 'addressLine1' | 'addressLine2' | 'postalCode' | 'city' | 'state'
  | 'countryCode' | 'countryName' | 'preferredLanguage' | 'notes'
  | 'featureCalendar' | 'featureQuotes' | 'featureBills' | 'featureHoursLogging' | 'featureContracts'
  | 'hourlyRateMinor' | 'billingCadence' | 'billingCycleDay' | 'skontoDisabled';

// `fmtDate` (from useLocalizedDate, below) is the single canonical date
// formatter. It honors the admin's `general_date_format` setting AND
// the active i18next locale. Per memory:
//   `feedback_respect_general_format_settings.md` — every displayed
//   date must route through useLocalizedDate(). Previously this file
//   had a local `formatDate(iso)` using date-fns 'PP' that ignored
//   both settings and locale — two rows on the same customer page
//   were rendering dates in two different formats.

export const CustomerDetailPage: React.FC = () => {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const customerId = Number(id);
  // Master "Hours logging" flag (Settings → Features). When off, the
  // per-customer toggle in the features card is hidden and the
  // HoursSection card never renders, regardless of customer state.
  const { flags } = useFeatureFlags();

  const { data: customer, isLoading, error } = useQuery({
    queryKey: ['admin-customer', customerId],
    queryFn: () => customerAdminService.get(customerId),
    enabled: Number.isFinite(customerId) && customerId > 0,
  });

  // Open monthly draft preview (migration 128). Powers the
  // "Pending in this month's bill" list shown between the cadence
  // controls and the Trigger button. null until the first invoice
  // line is appended; refetched on every trigger / invoice mutation.
  const { format: fmtDate } = useLocalizedDate();
  const { data: monthlyDraftRes } = useQuery({
    queryKey: ['admin-customer-monthly-draft', customerId],
    queryFn: () => customerAdminService.getMonthlyDraft(customerId),
    enabled: Number.isFinite(customerId) && customerId > 0
      && (customer?.billingCadence === 'monthly' || customer?.billingCadence === 'manual'),
  });
  const monthlyDraft = monthlyDraftRes?.draft || null;

  // Business-profile default locale powers the "Preferred language"
  // dropdown's helper hint — admins see which language a brand-new
  // customer would inherit and decide whether to override it.
  const { data: profileSnapshot } = useQuery({
    queryKey: ['business-profile-snapshot'],
    queryFn: () => businessProfileService.get(),
    staleTime: 5 * 60 * 1000,
  });
  const profileDefaultLocale = profileSnapshot?.profile?.defaultLocale || 'en';
  // #3 — the hourly-rate hint used to hardcode "CHF" in its example.
  // Pull the configured default currency so installs running EUR /
  // USD / GBP get a meaningful example instead of one referencing a
  // currency they don't use.
  const profileDefaultCurrency = profileSnapshot?.profile?.defaultCurrency || 'CHF';
  const LOCALE_LABELS: Record<string, string> = {
    en: 'English', de: 'Deutsch', fr: 'Français',
    nl: 'Nederlands', pt: 'Português', ru: 'Русский',
  };

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
        countryName: customer.countryName,
        preferredLanguage: customer.preferredLanguage,
        notes: customer.notes,
        featureCalendar: customer.featureCalendar ?? false,
        featureQuotes:   customer.featureQuotes   ?? false,
        featureBills:    customer.featureBills    ?? false,
        featureHoursLogging: customer.featureHoursLogging ?? false,
        // Contracts is opt-OUT (default on) — preserve the tab for customers
        // saved before the per-customer override existed.
        featureContracts: customer.featureContracts ?? true,
        hourlyRateMinor: customer.hourlyRateMinor ?? null,
        billingCadence: customer.billingCadence ?? 'per_event',
        billingCycleDay: customer.billingCycleDay ?? 1,
        skontoDisabled: customer.skontoDisabled ?? false,
      } as any);
    }
  }, [customer, form]);

  const toggleFeature = (key: 'featureCalendar' | 'featureQuotes' | 'featureBills' | 'featureHoursLogging' | 'featureContracts') => {
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
      // Surface field-level validation errors so admin can see WHICH
      // field failed instead of a generic "Validation failed" toast.
      // The backend returns details: [{ field, message }] via the
      // ValidationError class in routeHelpers.js.
      const details = e?.response?.data?.details;
      let msg: string;
      if (e?.response?.status === 409) {
        msg = t('customers.detail.emailConflict', 'That email is already in use by another customer.');
      } else if (Array.isArray(details) && details.length > 0) {
        msg = `${e.response.data.error || 'Validation failed'}: ${details.map((d: any) => `${d.field} (${d.message})`).join(', ')}`;
      } else {
        msg = e?.response?.data?.error || t('customers.detail.saveError', 'Could not save changes.');
      }
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

  // Promote a passive customer to active by firing the standard
  // portal-invitation email. On success we invalidate the customer
  // query so the badge + the "Has portal access" copy update once
  // the customer actually claims the invite (next reload).
  const sendInviteMutation = useMutation({
    mutationFn: () => customerAdminService.sendInvite(customerId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-customer', customerId] });
      toast.success(t('customers.passive.sendInviteToast', 'Portal invitation sent.'));
    },
    onError: (err: any) => {
      if (err?.response?.data?.code === 'CUSTOMER_ALREADY_ACTIVE') {
        toast.error(t('customers.passive.alreadyActive',
          'Customer already has portal access — no invitation needed.'));
      } else {
        toast.error(err?.response?.data?.error || err?.message || t('common.error', 'Something went wrong.'));
      }
    },
  });

  // Admin override — issue the customer's running monthly draft NOW
  // instead of waiting for the cadence-day scheduler tick. Used when
  // the customer asks for an out-of-cycle bill or a project wraps
  // before the configured day. Surfaces backend errors verbatim so
  // admin sees "No pending monthly bill" / "Draft is empty" when the
  // queue isn't ready.
  const triggerMonthlyBillMutation = useMutation({
    mutationFn: () => customerAdminService.triggerMonthlyBill(customerId),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['admin-customer', customerId] });
      queryClient.invalidateQueries({ queryKey: ['admin-customer-hour-entries', customerId] });
      // Clear the draft preview so the list collapses to empty
      // immediately after the trigger ships — a new draft is minted
      // on the next createInvoice / hour-entry append.
      queryClient.invalidateQueries({ queryKey: ['admin-customer-monthly-draft', customerId] });
      toast.success(
        t('customers.billing.triggered',
          'Monthly bill issued: {{number}}',
          { number: result.invoiceNumber }),
      );
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.error
        || t('customers.billing.triggerError', 'Could not trigger the monthly bill.'));
    },
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
            <ArrowLeft className="w-4 h-4 text-neutral-500 dark:text-neutral-400" />
          </Link>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100 truncate">
              {customer.displayName || customer.email}
            </h1>
            <p className="text-sm text-neutral-500 dark:text-neutral-400 truncate">{customer.email}</p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
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
          {customer.isPassive ? (
            <span
              className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300"
              title={t(
                'customers.passive.detailHint',
                'This customer has no portal access (admin-only record). Click "Send portal invitation" below to email them a sign-up link.',
              ) as string}
            >
              {t('customers.passive.badge', 'Passive — admin only')}
            </span>
          ) : (
            <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
              {t('customers.passive.activeLabel', 'Has portal access')}
            </span>
          )}
        </div>
      </div>

      {/* Account section */}
      <Card padding="lg">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4 flex items-center gap-2">
          <Mail className="w-5 h-5" /> {t('customers.detail.accountSection', 'Account')}
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-neutral-900 dark:text-neutral-100 mb-1">{t('customers.detail.email', 'Email')}</label>
            <Input type="email" value={form.email || ''} onChange={setField('email')} />
          </div>
          <div>
            <label className="block text-sm font-medium text-neutral-900 dark:text-neutral-100 mb-1">{t('customers.detail.preferredLanguage', 'Preferred language')}</label>
            <select
              value={form.preferredLanguage || profileDefaultLocale}
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
            <p className="text-xs text-neutral-500 mt-1">
              {t('customers.detail.preferredLanguageHint',
                'Drives portal UI and quote/invoice PDF locale. New customers default to the business-profile language ({{lang}}); override here per customer.',
                { lang: LOCALE_LABELS[profileDefaultLocale] || profileDefaultLocale.toUpperCase() })}
            </p>
          </div>
        </div>
      </Card>

      {/* Personal section */}
      <Card padding="lg">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">
          {t('customers.detail.personalSection', 'Personal information')}
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-neutral-900 dark:text-neutral-100 mb-1">{t('customers.detail.salutation', 'Salutation')}</label>
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
            <label className="block text-sm font-medium text-neutral-900 dark:text-neutral-100 mb-1">{t('customers.detail.firstName', 'First name')}</label>
            <Input value={form.firstName || ''} onChange={setField('firstName')} />
          </div>
          <div>
            <label className="block text-sm font-medium text-neutral-900 dark:text-neutral-100 mb-1">{t('customers.detail.lastName', 'Last name')}</label>
            <Input value={form.lastName || ''} onChange={setField('lastName')} />
          </div>
          <div>
            <label className="block text-sm font-medium text-neutral-900 dark:text-neutral-100 mb-1">{t('customers.detail.displayName', 'Display name')}</label>
            <Input value={form.displayName || ''} onChange={setField('displayName')} />
          </div>
          <div>
            <label className="block text-sm font-medium text-neutral-900 dark:text-neutral-100 mb-1 flex items-center gap-1">
              <Phone className="w-4 h-4" /> {t('customers.detail.phone', 'Phone')}
            </label>
            <Input value={form.phone || ''} onChange={setField('phone')} />
          </div>
          <div>
            <label className="block text-sm font-medium text-neutral-900 dark:text-neutral-100 mb-1 flex items-center gap-1">
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
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4 flex items-center gap-2">
          <FileText className="w-5 h-5" /> {t('customers.detail.notesSection', 'Internal notes')}
        </h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-3">
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
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 flex items-center gap-2">
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
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            {t('customers.detail.noEvents', 'Not assigned to any events yet. Use "Manage galleries" to add some.')}
          </p>
        ) : (
          <ul className="divide-y divide-neutral-200 dark:divide-neutral-700">
            {customer.events.map((ev) => (
              <li key={ev.id} className="py-2 flex items-center justify-between">
                <Link to={`/admin/events/${ev.id}`} className="text-neutral-900 dark:text-neutral-100 hover:underline">
                  {ev.eventName}
                </Link>
                <span className="text-xs text-neutral-500 dark:text-neutral-400">
                  {ev.eventDate ? fmtDate(ev.eventDate) : ''}
                  {ev.expiresAt ? ` · ${t('customers.detail.expires', 'expires')} ${fmtDate(ev.expiresAt)}` : ''}
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
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4 flex items-center gap-2">
          <MapPin className="w-5 h-5" /> {t('customers.detail.billingSection', 'Address & billing')}
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-neutral-900 dark:text-neutral-100 mb-1">{t('customers.detail.billingEmail', 'Billing email')}</label>
            <Input type="email" value={form.billingEmail || ''} onChange={setField('billingEmail')} />
          </div>
          <div>
            <label className="block text-sm font-medium text-neutral-900 dark:text-neutral-100 mb-1">{t('customers.detail.vatId', 'VAT / tax ID')}</label>
            <Input value={form.vatId || ''} onChange={setField('vatId')} />
          </div>
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-neutral-900 dark:text-neutral-100 mb-1">{t('customers.detail.addressLine1', 'Address line 1')}</label>
            <Input value={form.addressLine1 || ''} onChange={setField('addressLine1')} />
          </div>
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-neutral-900 dark:text-neutral-100 mb-1">{t('customers.detail.addressLine2', 'Address line 2')}</label>
            <Input value={form.addressLine2 || ''} onChange={setField('addressLine2')} />
          </div>
          <div>
            <label className="block text-sm font-medium text-neutral-900 dark:text-neutral-100 mb-1">{t('customers.detail.postalCode', 'Postal code')}</label>
            <Input value={form.postalCode || ''} onChange={setField('postalCode')} />
          </div>
          <div>
            <label className="block text-sm font-medium text-neutral-900 dark:text-neutral-100 mb-1">{t('customers.detail.city', 'City')}</label>
            <Input value={form.city || ''} onChange={setField('city')} />
          </div>
          <div>
            <label className="block text-sm font-medium text-neutral-900 dark:text-neutral-100 mb-1">{t('customers.detail.state', 'State / region')}</label>
            <Input value={form.state || ''} onChange={setField('state')} />
          </div>
          <div>
            <CountrySelect
              label={t('customers.detail.country', 'Country') as string}
              value={form.countryCode || ''}
              onChange={(code) => setForm((prev) => ({ ...prev, countryCode: code }))}
            />
          </div>
          {/* The free-text "Country (full name)" override (migration 107) was
              removed as redundant — the country picker stores the ISO code and
              the PDF renderer derives the localized full name from it
              (pdfService.countryName). The DB column + the `country_name ||`
              fallback stay, so any legacy override still renders. */}
        </div>
      </Card>

      {/* Quotes + Invoices history (CRM #TBD).
          Each panel renders a compact list scoped to this customer. The
          panels are independently feature-flagged so they vanish for
          installs that haven't turned the master quotes/bills flag on.
          The flag check lives in <CustomerCrmPanels /> so this page
          doesn't need to import useFeatureFlags directly. */}
      <CustomerCrmPanels customerAccountId={customer.id} />

      {/* Per-customer feature flags (#354 follow-up). Sits
          second-to-last by request — admins glance at these least
          often, but they need to live above the destructive
          "Account actions" row so the feature surface and its
          actions read as one unit. */}
      {/* Hide the whole Card when every flag that could surface a
          toggle inside it is OFF — an empty "Customer features" card
          with just a title + hint reads as broken. The Card reappears
          the moment any master flag is re-enabled. */}
      {(flags.calendar || flags.quotes || flags.bills || flags.hoursLogging || flags.contracts) && (
      <Card padding="lg">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-1 flex items-center gap-2">
          <ToggleLeft className="w-5 h-5" />
          {t('customers.detail.featuresSection', 'Customer features')}
        </h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-4">
          {t(
            'customers.detail.featuresHint',
            'Per-customer overrides for the customer-surface tabs. The global toggles in Settings → Features are the master switch — when global is OFF nobody sees the tab, regardless of what you set here. Defaults are ON, so flip a switch OFF to hide a tab for this specific customer.'
          )}
        </p>
        <div className="space-y-3">
          {([
            // Each per-customer toggle hides when its master feature
            // flag is OFF — the toggle would do nothing in that state
            // and only confuses the admin. The "feature is disabled
            // globally" signal is conveyed by the row simply not
            // appearing, mirroring the hoursLogging pattern below.
            //
            // `badge` controls which status pill is shown:
            //   - 'soon' (amber) for tabs that still don't have a
            //     customer-facing surface (Calendar booking)
            //   - 'new' (green) for shipped customer-facing tabs that
            //     are recent additions to the admin's vocabulary so
            //     they catch the eye when reviewing per-customer
            //     overrides. Matches Settings → Features StatusBadge.
            ...(flags.calendar
              ? [{ key: 'featureCalendar' as const, labelKey: 'customer.nav.calendar', fallback: 'Calendar', badge: 'soon' as const }]
              : []),
            ...(flags.quotes
              ? [{ key: 'featureQuotes' as const,   labelKey: 'customer.nav.quotes',   fallback: 'Quotes',   badge: 'new'  as const }]
              : []),
            ...(flags.bills
              ? [{ key: 'featureBills' as const,    labelKey: 'customer.nav.bills',    fallback: 'Bills',    badge: 'new'  as const }]
              : []),
            ...(flags.hoursLogging
              ? [{ key: 'featureHoursLogging' as const, labelKey: 'customers.field.featureHoursLogging', fallback: 'Hours logging', badge: 'new' as const }]
              : []),
            ...(flags.contracts
              ? [{ key: 'featureContracts' as const, labelKey: 'customer.nav.contracts', fallback: 'Contracts', badge: 'new' as const }]
              : []),
          ] as const).map(({ key, labelKey, fallback, badge }) => {
            const enabled = !!form[key];
            return (
              <label key={key} className="flex items-center justify-between gap-3 cursor-pointer">
                <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100 flex items-center gap-2">
                  {t(labelKey, fallback)}
                  {/* Status pill — 'soon' = amber, 'new' = green.
                      Colors match Settings → Features StatusBadge so
                      the two surfaces feel consistent. */}
                  {badge === 'soon' ? (
                    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-semibold bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                      {t('customer.nav.soon', 'Soon')}
                    </span>
                  ) : (
                    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-semibold bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300">
                      {t('customer.nav.new', 'New')}
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={enabled}
                  onClick={() => toggleFeature(key)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${enabled ? '' : 'bg-neutral-300 dark:bg-neutral-600'}`}
                  style={enabled ? { backgroundColor: 'var(--color-accent)' } : undefined}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'}`}
                  />
                </button>
              </label>
            );
          })}
        </div>

        {/* Default hourly rate (migration 129). Only shown when the
            master `hoursLogging` flag is on AND the per-customer
            toggle is on — admin shouldn't see a rate field for a
            customer who isn't using hours logging. The rate is the
            DEFAULT for new entries; admin can still override on a
            per-entry basis from the standalone Hours logging page. */}
        {flags.hoursLogging && form.featureHoursLogging && (
          <div className="mt-4 pt-4 border-t border-neutral-200 dark:border-neutral-700">
            <label className="block text-sm font-medium text-neutral-900 dark:text-neutral-100 mb-1">
              {t('customers.field.hourlyRate', 'Default hourly rate')}
            </label>
            <DecimalInput
              value={form.hourlyRateMinor != null ? form.hourlyRateMinor / 100 : NaN}
              fractionDigits={2}
              onChange={(n) => {
                setForm((prev) => ({
                  ...prev,
                  hourlyRateMinor: Number.isFinite(n) ? Math.max(0, Math.round(n * 100)) : null,
                } as any));
              }}
              placeholder="150.00"
              className="w-40 input"
            />
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
              {t('customers.field.hourlyRateHint',
                'Major units (e.g. 150.00 for {{currency}} 150). Leave blank to require a per-entry override on every block.',
                { currency: profileDefaultCurrency })}
            </p>
          </div>
        )}
      </Card>
      )}

      {/* Billing cadence (migration 102 + 128). Per-event keeps the
          standard invoice-per-event flow; monthly accumulates all
          invoices issued in a period into one consolidated bill that
          fires on the configured cadence day. Cycle day uses
          positive 1–28 for day-of-month, negative -1..-15 for days
          before month end. Hidden entirely when the bills feature is
          off — admin has nothing to bill, so cadence is moot. */}
      {flags.bills && (
      <Card padding="lg">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-1 flex items-center gap-2">
          <Calendar className="w-5 h-5" />
          {t('customers.billing.section', 'Billing cadence')}
        </h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-4">
          {t('customers.billing.hint',
            'Per-event (default): every invoice is sent on its own schedule. Monthly: all invoices issued in the period accumulate into one bill that fires on the configured day.')}
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-neutral-900 dark:text-neutral-100 mb-1">
              {t('customers.billing.cadence', 'Billing cadence')}
            </label>
            <select
              value={form.billingCadence || 'per_event'}
              onChange={(e) => setForm((prev) => ({ ...prev, billingCadence: e.target.value } as any))}
              className="input w-full"
            >
              <option value="per_event">{t('customers.billing.perEvent', 'Per event')}</option>
              <option value="monthly">{t('customers.billing.monthly', 'Monthly')}</option>
              <option value="quarterly">{t('customers.billing.quarterly', 'Quarterly')}</option>
              <option value="manual">{t('customers.billing.manual', 'Manual (trigger only)')}</option>
            </select>
          </div>
          {(form.billingCadence === 'monthly' || form.billingCadence === 'quarterly') && (
            <div>
              <label className="block text-sm font-medium text-neutral-900 dark:text-neutral-100 mb-1">
                {t('customers.billing.cycleDay', 'Cycle day')}
              </label>
              <input
                type="number"
                min={-15}
                max={28}
                value={form.billingCycleDay ?? 1}
                onChange={(e) => setForm((prev) => ({ ...prev, billingCycleDay: Number(e.target.value) } as any))}
                className="input w-full"
              />
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                {t('customers.billing.cycleDayHint',
                  '1..28 = day of month. Use negative -1..-15 for "N days before month end" (so -3 fires on the 28th of a 31-day month).')}
              </p>
            </div>
          )}
        </div>

        {/* Per-customer Skonto opt-out (migration 112). For B2B
            customers who negotiated "no early-payment discount" — set
            once instead of ticking the per-invoice toggle every time. */}
        <label className="mt-4 flex items-start gap-2 text-sm text-neutral-900 dark:text-neutral-100">
          <input
            type="checkbox"
            checked={!!form.skontoDisabled}
            onChange={(e) => setForm((prev) => ({ ...prev, skontoDisabled: e.target.checked } as any))}
            className="mt-0.5 rounded border-neutral-300 dark:border-neutral-600"
          />
          <span>
            {t('customers.billing.skontoDisabled', 'No Skonto for this customer')}
            <span className="block text-xs text-neutral-500 dark:text-neutral-400">
              {t('customers.billing.skontoDisabledHint',
                'Disables the early-payment discount on all of this customer’s invoices, regardless of template or global defaults.')}
            </span>
          </span>
        </label>

        {/* Preview of the open monthly draft (migration 128). Shows
            every line item queued for the customer's current billing
            period so admin sees exactly what "Trigger invoice now"
            would ship. Hidden when no draft exists yet (admin hasn't
            saved anything onto the period). */}
        {(form.billingCadence === 'monthly' || form.billingCadence === 'manual') && monthlyDraft && monthlyDraft.lineItems.length > 0 && (
          <div className="mt-4 pt-4 border-t border-neutral-200 dark:border-neutral-700">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                {form.billingCadence === 'manual'
                  ? t('customers.billing.draftPreview.titleManual',
                      'Pending — ships on manual trigger')
                  : t('customers.billing.draftPreview.title',
                      'Pending in this month\'s bill')}
              </h3>
              <span className="text-xs text-neutral-500 dark:text-neutral-400">
                {monthlyDraft.periodStart && monthlyDraft.periodEnd
                  ? t('customers.billing.draftPreview.periodRange',
                      '{{number}} · {{from}} – {{to}}',
                      {
                        number: monthlyDraft.invoiceNumber,
                        from: fmtDate(monthlyDraft.periodStart),
                        to: fmtDate(monthlyDraft.periodEnd),
                      })
                  : monthlyDraft.invoiceNumber}
              </span>
            </div>
            <div className="rounded-lg border border-neutral-200 dark:border-neutral-700 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-neutral-50 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300">
                  <tr>
                    <th className="px-3 py-2 text-left w-12">#</th>
                    <th className="px-3 py-2 text-left">
                      {t('crm.lineItems.description', 'Description')}
                    </th>
                    <th className="px-3 py-2 text-right w-20">
                      {t('crm.lineItems.quantity', 'Qty')}
                    </th>
                    <th className="px-3 py-2 text-right w-28">
                      {t('crm.lineItems.unitPrice', 'Unit')}
                    </th>
                    <th className="px-3 py-2 text-right w-28">
                      {t('crm.lineItems.total', 'Total')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {monthlyDraft.lineItems.map((li) => (
                    <tr key={li.id} className="border-t border-neutral-200 dark:border-neutral-700">
                      <td className="px-3 py-1.5 tabular-nums text-neutral-500 dark:text-neutral-400">{li.position}</td>
                      <td className="px-3 py-1.5">
                        {li.parentPosition != null && (
                          <span className="text-neutral-500 dark:text-neutral-400 mr-1">↳</span>
                        )}
                        {li.description}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{li.quantity}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {formatMoney(li.unitPriceMinor / 100, monthlyDraft.currency)}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {formatMoney(li.lineTotalMinor / 100, monthlyDraft.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-neutral-50 dark:bg-neutral-800">
                  <tr className="border-t-2 border-neutral-300 dark:border-neutral-600">
                    <td colSpan={4} className="px-3 py-2 text-right font-medium">
                      {t('crm.lineItems.total', 'Total')}
                    </td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">
                      {formatMoney(monthlyDraft.totalAmountMinor / 100, monthlyDraft.currency)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        )}

        {/* Manual trigger — issue the running draft NOW. For monthly
            customers this bypasses the cadence-day scheduler tick; for
            manual-cadence customers it's the ONLY way the draft ships
            (the scheduler never auto-flushes a manual draft). Per-event
            has no draft to arm; the equivalent action there is "Bill
            these hours" on the standalone Hours-logging page. */}
        {(form.billingCadence === 'monthly' || form.billingCadence === 'manual') && (
          <div className="mt-4 pt-4 border-t border-neutral-200 dark:border-neutral-700">
            <Button
              variant="outline"
              disabled={triggerMonthlyBillMutation.isPending}
              isLoading={triggerMonthlyBillMutation.isPending}
              onClick={() => {
                const confirmMsg = form.billingCadence === 'manual'
                  ? t('customers.billing.triggerConfirmManual',
                      'Issue this customer\'s accumulated bill now? The customer receives the email immediately.')
                  : t('customers.billing.triggerConfirm',
                      'Issue this customer\'s monthly bill now? The customer receives the email immediately.');
                if (window.confirm(confirmMsg as string)) {
                  triggerMonthlyBillMutation.mutate();
                }
              }}
            >
              {t('customers.billing.triggerNow', 'Trigger invoice now')}
            </Button>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-2">
              {form.billingCadence === 'manual'
                ? t('customers.billing.triggerHintManual',
                    'Issues the running draft immediately. Manual-cadence drafts never ship automatically — this is the only way to send them. Refuses when nothing has been queued.')
                : t('customers.billing.triggerHint',
                    'Bypasses the cadence day and issues the running draft immediately. Refuses when nothing has been queued for the current period.')}
            </p>
          </div>
        )}
      </Card>
      )}

      {/* Hours section (migration 129). Only renders when the
          feature_hours_logging toggle above is on. Lives between
          features and account-actions so admins see it right after
          flipping the toggle. */}
      {flags.hoursLogging && form.featureHoursLogging && (
        <HoursSection
          customerId={customerId}
          customerHourlyRateMinor={form.hourlyRateMinor ?? null}
          billingCadence={(form.billingCadence as any) || customer.billingCadence || 'per_event'}
          // compact: history-only + per-event "Bill these hours"
          // button. Logging lives on the standalone
          // /admin/clients/hours surface so admins have ONE place to
          // record new entries; the customer detail page just
          // surfaces what's already on the books.
          compact
        />
      )}

      {/* Account actions: password reset OR portal invitation
          (#354 follow-up + passive-customer flow). Passive customers
          don't have a password to reset — the equivalent action is
          firing the standard portal-invitation email. We show ONE
          card with the right action based on the customer's state. */}
      <Card padding="lg">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-1 flex items-center gap-2">
          <KeyRound className="w-5 h-5" />
          {t('customers.detail.passwordSection', 'Account actions')}
        </h2>
        {customer.isPassive ? (
          <>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-4">
              {t(
                'customers.passive.detailHint',
                'This customer has no portal access (admin-only record). Click below to email them a portal sign-up link. The customer\'s existing invoices, quotes, and gallery assignments are preserved when they claim the invitation.',
              )}
            </p>
            <Button
              variant="primary"
              leftIcon={<KeyRound className="w-4 h-4" />}
              isLoading={sendInviteMutation.isPending}
              disabled={!customer.isActive || sendInviteMutation.isPending}
              onClick={() => sendInviteMutation.mutate()}
            >
              {t('customers.passive.sendInvite', 'Send portal invitation')}
            </Button>
            {!customer.isActive && (
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-2">
                {t('customers.passive.deactivatedHint',
                  'Reactivate the customer before sending the invitation.')}
              </p>
            )}
          </>
        ) : (
          <>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-4">
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
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-2">
                {t('customers.detail.passwordReset.inactive', 'Reactivate the customer before sending a reset.')}
              </p>
            )}
          </>
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
          <div className="w-full max-w-md rounded-xl shadow-lg bg-white dark:bg-neutral-900">
            <div className="p-6">
              <div className="flex items-start gap-3 mb-4">
                <AlertTriangle className="w-5 h-5 mt-0.5 text-amber-500" />
                <div>
                  <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
                    {t('customers.deactivate.title', 'Deactivate customer?')}
                  </h2>
                  <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
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
          <div className="w-full max-w-md rounded-xl shadow-lg bg-white dark:bg-neutral-900">
            <div className="p-6">
              <div className="flex items-start gap-3 mb-4">
                <AlertTriangle className="w-5 h-5 mt-0.5 text-red-600" />
                <div>
                  <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
                    {t('customers.erase.title', 'Erase customer data?')}
                  </h2>
                  <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
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
