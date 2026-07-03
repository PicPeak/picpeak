/**
 * Inline "+ Create new customer" form mounted inside the quote /
 * invoice editor's customer card.
 *
 * Two save modes:
 *   - "Save as passive customer" → POST /admin/customers. No email,
 *     no invitation. The customer becomes a usable record
 *     immediately for the current quote/invoice.
 *   - "Save & send portal invitation" → POST /admin/customers
 *     followed by POST /admin/customers/:id/send-invite. Customer is
 *     created (passive in DB), then a standard onboarding email is
 *     queued so they can claim portal access. Orchestrated client-
 *     side so the backend endpoints stay simple and single-purpose.
 *
 * If the second call fails after the first succeeds, the customer
 * stays saved (passive) and a warning toast asks the admin to retry
 * from the customer detail page.
 *
 * Field set mirrors the customer detail page so admins see the same
 * shape regardless of where they're editing.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { Save, Send, X } from 'lucide-react';
import { Button, CountrySelect, Input } from '../common';
import {
  customerAdminService,
  type CustomerAccountDetail,
  type CustomerInvitePrefill,
} from '../../services/customerAdmin.service';
import { businessProfileService } from '../../services/businessProfile.service';
import { useQuery } from '@tanstack/react-query';

interface Props {
  /**
   * Fires after a successful save. The customer payload is the same
   * shape the customer-detail endpoint returns, so callers can use
   * its id/email/company directly to populate the quote/invoice's
   * customer pin.
   */
  onCreated: (customer: CustomerAccountDetail) => void;
  /** Revert the editor card back to the search-only state. */
  onCancel: () => void;
  /**
   * Which save action(s) the form should expose.
   *  - 'both' (default): renders both buttons — used by the quote /
   *    invoice editors where the admin picks the mode in-place.
   *  - 'passive': renders only "Save as passive customer".
   *  - 'invite': renders only "Save & send portal invitation".
   * The "passive" / "invite" specialisations let CustomerManagementPage
   * route both header buttons through the same modal — the only
   * difference between the two flows is which action button shows.
   */
  mode?: 'both' | 'passive' | 'invite';
}

type FormState = {
  email: string;
  salutation: string;
  firstName: string;
  lastName: string;
  displayName: string;
  phone: string;
  companyName: string;
  vatId: string;
  addressLine1: string;
  addressLine2: string;
  postalCode: string;
  city: string;
  state: string;
  countryCode: string;
  preferredLanguage: string;
};

const empty: FormState = {
  email: '', salutation: '', firstName: '', lastName: '', displayName: '',
  phone: '', companyName: '', vatId: '',
  addressLine1: '', addressLine2: '', postalCode: '', city: '', state: '',
  countryCode: '', preferredLanguage: '',
};

function buildPrefill(f: FormState): CustomerInvitePrefill {
  // Backend's PREFILLABLE_FIELDS uses snake_case. Translate at the
  // wire boundary and drop empty strings so the server doesn't store
  // "" where null would be more honest.
  const out: CustomerInvitePrefill = {};
  if (f.salutation)      out.salutation = f.salutation;
  if (f.firstName)       out.first_name = f.firstName;
  if (f.lastName)        out.last_name = f.lastName;
  if (f.displayName)     out.display_name = f.displayName;
  if (f.phone)           out.phone = f.phone;
  if (f.companyName)     out.company_name = f.companyName;
  if (f.vatId)           out.vat_id = f.vatId;
  if (f.addressLine1)    out.address_line1 = f.addressLine1;
  if (f.addressLine2)    out.address_line2 = f.addressLine2;
  if (f.postalCode)      out.postal_code = f.postalCode;
  if (f.city)            out.city = f.city;
  if (f.state)           out.state = f.state;
  if (f.countryCode)     out.country_code = f.countryCode.toUpperCase();
  if (f.preferredLanguage) out.preferred_language = f.preferredLanguage;
  return out;
}

export const InlineCustomerCreate: React.FC<Props> = ({ onCreated, onCancel, mode = 'both' }) => {
  const { t } = useTranslation();
  const [form, setForm] = useState<FormState>(empty);
  const [busy, setBusy] = useState<'passive' | 'invite' | null>(null);

  // Resolve a title + subtitle that matches the selected mode. The
  // 'both' branch keeps the legacy copy so inline (in-editor) callers
  // see the same wording they had before this prop existed.
  const heading = mode === 'invite'
    ? {
        title: t('customers.invite.title', 'Invite a customer'),
        subtitle: t('customers.invite.description',
          'They will receive an email with a link to set up their account. Once they have accepted, you can assign them to events.'),
      }
    : mode === 'passive'
      ? {
          title: t('customers.create.openButton', 'Create passive customer'),
          subtitle: t('customers.create.passiveSubtitle',
            'Adds an admin-only customer record. The customer is not notified and cannot log in until you send them an invitation later.'),
        }
      : {
          title: t('customers.create.title', 'Create new customer'),
          subtitle: t('customers.create.subtitle',
            'Fill in the details below. Choose "Save as passive customer" to create an admin-only record, or "Save & send portal invitation" to also email the customer a sign-up link.'),
        };

  // Business-profile default locale powers the preferred-language
  // hint AND seeds the field on mount.
  const { data: profileSnapshot } = useQuery({
    queryKey: ['business-profile-snapshot'],
    queryFn: () => businessProfileService.get(),
    staleTime: 5 * 60 * 1000,
  });
  const profileDefaultLocale = profileSnapshot?.profile?.defaultLocale || 'en';
  const profileCountryCode = profileSnapshot?.profile?.countryCode || '';

  // Seed preferredLanguage + countryCode with the profile defaults once
  // the profile arrives (only if the field is still empty so we don't
  // clobber explicit user input).
  React.useEffect(() => {
    setForm((prev) => {
      const next = { ...prev };
      if (profileDefaultLocale && !prev.preferredLanguage) next.preferredLanguage = profileDefaultLocale;
      if (profileCountryCode && !prev.countryCode) next.countryCode = profileCountryCode.toUpperCase();
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileDefaultLocale, profileCountryCode]);

  const setField = (key: keyof FormState) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((prev) => ({ ...prev, [key]: e.target.value }));

  const hasEmail = !!form.email && /\S+@\S+\.\S+/.test(form.email);
  // At least one human-readable identifier so the record isn't a
  // nameless row that's impossible to recognise in lists later.
  const hasName = !!(form.companyName.trim() || form.displayName.trim()
    || form.firstName.trim() || form.lastName.trim());
  const isValid = hasEmail && hasName;

  const handleSave = async (mode: 'passive' | 'invite') => {
    if (!hasEmail) {
      toast.error(t('customers.create.emailRequired', 'A valid email is required.'));
      return;
    }
    if (!hasName) {
      toast.error(t('customers.create.nameRequired',
        'Enter at least a company name or a contact name.'));
      return;
    }
    setBusy(mode);
    try {
      const customer = await customerAdminService.createDirect(form.email, buildPrefill(form));
      if (mode === 'invite') {
        // Customer is now saved as passive. Fire the second call to
        // promote them. If THIS fails, keep the customer selected
        // (it exists, just no email went out) and warn the admin.
        try {
          await customerAdminService.sendInvite(customer.id);
          toast.success(t('customers.create.savedActiveToast',
            'Customer created and portal invitation sent.'));
        } catch (err: any) {
          toast.warn(t('customers.create.inviteFailedToast',
            'Customer saved (passive). Invitation email failed — retry from the customer detail page.'));
          // eslint-disable-next-line no-console
          console.warn('sendInvite failed', err);
        }
      } else {
        toast.success(t('customers.create.savedPassiveToast',
          'Passive customer created.'));
      }
      onCreated(customer);
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || t('common.error', 'Something went wrong.');
      toast.error(String(msg));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3 mb-2">
        <div>
          <h4 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            {heading.title}
          </h4>
          <p className="text-xs text-neutral-600 dark:text-neutral-400 mt-0.5">
            {heading.subtitle}
          </p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="ml-auto p-1 rounded text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
          aria-label={t('common.cancel', 'Cancel') as string}
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Input
          type="email"
          label={`${t('customers.detail.email', 'Email')} *`}
          value={form.email}
          onChange={setField('email')}
          placeholder="name@example.com"
          required
        />
        <Input
          label={t('customers.detail.companyName', 'Company name') as string}
          value={form.companyName}
          onChange={setField('companyName')}
        />
        <div>
          <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
            {t('customers.detail.salutation', 'Salutation')}
          </label>
          {/* Salutation values are stored verbatim ("Herr", "Frau",
              "Mx", "Dr") — canonical tokens across locales. Display
              labels are translated; the option's value stays in the
              German form so the same key works regardless of which
              locale the admin is editing in. Matches CustomerDetailPage. */}
          <select
            value={form.salutation}
            onChange={setField('salutation')}
            className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100"
          >
            <option value="">{t('customer.profile.salutation.none', '— Not specified —')}</option>
            <option value="Herr">{t('customer.profile.salutation.herr', 'Mr.')}</option>
            <option value="Frau">{t('customer.profile.salutation.frau', 'Ms.')}</option>
            <option value="Mx">{t('customer.profile.salutation.mx', 'Mx')}</option>
            <option value="Dr">{t('customer.profile.salutation.dr', 'Dr.')}</option>
          </select>
        </div>
        <Input
          label={t('customers.detail.phone', 'Phone') as string}
          value={form.phone}
          onChange={setField('phone')}
        />
        <Input
          label={t('customers.detail.firstName', 'First name') as string}
          value={form.firstName}
          onChange={setField('firstName')}
        />
        <Input
          label={t('customers.detail.lastName', 'Last name') as string}
          value={form.lastName}
          onChange={setField('lastName')}
        />
        <Input
          label={t('customers.detail.displayName', 'Display name') as string}
          value={form.displayName}
          onChange={setField('displayName')}
        />
        <Input
          label={t('customers.detail.vatId', 'VAT ID') as string}
          value={form.vatId}
          onChange={setField('vatId')}
        />
        <div className="md:col-span-2">
          <Input
            label={t('customers.detail.addressLine1', 'Address line 1') as string}
            value={form.addressLine1}
            onChange={setField('addressLine1')}
          />
        </div>
        <div className="md:col-span-2">
          <Input
            label={t('customers.detail.addressLine2', 'Address line 2') as string}
            value={form.addressLine2}
            onChange={setField('addressLine2')}
          />
        </div>
        <Input
          label={t('customers.detail.postalCode', 'Postal code') as string}
          value={form.postalCode}
          onChange={setField('postalCode')}
        />
        <Input
          label={t('customers.detail.city', 'City') as string}
          value={form.city}
          onChange={setField('city')}
        />
        <Input
          label={t('customers.detail.state', 'State / canton') as string}
          value={form.state}
          onChange={setField('state')}
        />
        <CountrySelect
          label={t('customers.detail.country', 'Country') as string}
          value={form.countryCode}
          onChange={(code) => setForm((prev) => ({ ...prev, countryCode: code }))}
        />
        <div className="md:col-span-2">
          <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
            {t('customers.detail.preferredLanguage', 'Preferred language')}
          </label>
          <select
            value={form.preferredLanguage || ''}
            onChange={setField('preferredLanguage')}
            className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100"
          >
            <option value="en">English</option>
            <option value="de">Deutsch</option>
            <option value="fr">Français</option>
            <option value="nl">Nederlands</option>
            <option value="pt">Português</option>
            <option value="ru">Русский</option>
          </select>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-neutral-200 dark:border-neutral-700">
        <Button variant="outline" onClick={onCancel} disabled={busy !== null}>
          {t('common.cancel', 'Cancel')}
        </Button>
        {(mode === 'both' || mode === 'passive') && (
          <Button
            variant={mode === 'passive' ? 'primary' : 'outline'}
            onClick={() => handleSave('passive')}
            disabled={busy !== null || !isValid}
            isLoading={busy === 'passive'}
            leftIcon={<Save className="w-4 h-4" />}
          >
            {/* Mode 'passive' is the dedicated CTA: promote it to the
                primary variant so the button hierarchy mirrors what
                an admin who opened the modal from "Create passive
                customer" expects. */}
            {t('customers.create.saveAsPassive', 'Save as passive customer')}
          </Button>
        )}
        {(mode === 'both' || mode === 'invite') && (
          <Button
            variant="primary"
            onClick={() => handleSave('invite')}
            disabled={busy !== null || !isValid}
            isLoading={busy === 'invite'}
            leftIcon={<Send className="w-4 h-4" />}
          >
            {t('customers.create.saveAndInvite', 'Save & send portal invitation')}
          </Button>
        )}
      </div>
    </div>
  );
};
