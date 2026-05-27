/**
 * Customer accept-invite page (#354).
 *
 * Mounted at /customer/invite/:token. Public route — anyone with the link
 * can complete the invitation. The token IS the auth: 256 bits of entropy,
 * single-use, 7-day TTL, server-side validated.
 *
 * Now collects the full profile (#354 follow-up):
 *   - admin can pre-fill any subset on /admin/customers invite, those
 *     values appear pre-populated and editable here
 *   - customer can correct or fill in anything else (phone, billing
 *     address, company)
 *   - password is the only required field besides the display name
 *
 * The profile fields are optional — a customer who just wants to log in
 * fast can leave them blank and edit later from /customer/profile.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Lock, MapPin, Phone, User as UserIcon, AlertCircle, CheckCircle } from 'lucide-react';
import { toast } from 'react-toastify';
import { useTranslation } from 'react-i18next';

import { Button, Input, Card, Loading } from '../../components/common';
import {
  customerService,
  type CustomerInvitationInfo,
  type CustomerProfilePrefill,
} from '../../services/customer.service';
import { usePublicSettings } from '../../hooks/usePublicSettings';

interface FormState {
  display_name: string;
  password: string;
  confirm: string;
  salutation: string;
  first_name: string;
  last_name: string;
  phone: string;
  company_name: string;
  vat_id: string;
  address_line1: string;
  address_line2: string;
  postal_code: string;
  city: string;
  state: string;
  country_code: string;
}

const SALUTATION_OPTIONS = [
  { value: '', labelKey: 'customer.profile.salutation.none', fallback: '— Not specified —' },
  { value: 'Herr', labelKey: 'customer.profile.salutation.herr', fallback: 'Herr' },
  { value: 'Frau', labelKey: 'customer.profile.salutation.frau', fallback: 'Frau' },
  { value: 'Mx', labelKey: 'customer.profile.salutation.mx', fallback: 'Mx' },
  { value: 'Dr', labelKey: 'customer.profile.salutation.dr', fallback: 'Dr.' },
];

const EMPTY: FormState = {
  display_name: '', password: '', confirm: '',
  salutation: '', first_name: '', last_name: '',
  phone: '', company_name: '', vat_id: '',
  address_line1: '', address_line2: '', postal_code: '', city: '', state: '', country_code: '',
};

export const CustomerAcceptInvitePage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { token = '' } = useParams<{ token: string }>();

  const [invitation, setInvitation] = useState<CustomerInvitationInfo | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [isLookingUp, setIsLookingUp] = useState(true);

  const [form, setForm] = useState<FormState>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { data: settingsData } = usePublicSettings();
  const companyName = settingsData?.branding_company_name?.trim() || 'PicPeak';
  const logoUrl = settingsData?.branding_logo_url?.trim();
  const resolvedLogoUrl = logoUrl || '/picpeak-logo-transparent.png';

  // Pre-flight invitation lookup. The response carries any prefill data
  // the admin attached on /admin/customers invite — populate the form
  // with that so the customer doesn't retype what their photographer
  // already knows.
  useEffect(() => {
    let cancelled = false;
    setIsLookingUp(true);
    customerService.getInvitation(token)
      .then((info) => {
        if (cancelled) return;
        setInvitation(info);
        if (info.prefill) {
          setForm((prev) => ({ ...prev, ...mergePrefillIntoForm(prev, info.prefill!) }));
        }
      })
      .catch(() => {
        if (cancelled) return;
        setLookupError(t(
          'customer.acceptInvite.invalidToken',
          'This invitation link is invalid or has expired. Please contact your photographer for a new invitation.'
        ));
      })
      .finally(() => {
        if (!cancelled) setIsLookingUp(false);
      });
    return () => { cancelled = true; };
  }, [token, t]);

  /**
   * The display_name shown in the form is admin-prefilled if available,
   * otherwise constructed from first/last name so the customer sees
   * something sensible without us silently changing what they type.
   */
  const initialDisplayName = useMemo(() => {
    if (form.display_name) return form.display_name;
    const fromParts = [form.first_name, form.last_name].filter(Boolean).join(' ').trim();
    return fromParts || '';
  }, [form.display_name, form.first_name, form.last_name]);

  const update = (key: keyof FormState, value: string) => {
    setForm((p) => ({ ...p, [key]: value }));
  };

  const validate = (): boolean => {
    const next: Record<string, string> = {};
    if (!initialDisplayName.trim()) {
      next.display_name = t('customer.acceptInvite.nameRequired', 'Please enter your name');
    }
    if (form.password.length < 8) {
      next.password = t('customer.acceptInvite.passwordTooShort', 'Password must be at least 8 characters');
    }
    if (form.password !== form.confirm) {
      next.confirm = t('customer.acceptInvite.passwordsMismatch', 'Passwords do not match');
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    setIsSubmitting(true);
    try {
      const profile: CustomerProfilePrefill = {
        salutation: form.salutation || undefined,
        first_name: form.first_name || undefined,
        last_name: form.last_name || undefined,
        display_name: form.display_name || undefined,
        phone: form.phone || undefined,
        company_name: form.company_name || undefined,
        vat_id: form.vat_id || undefined,
        address_line1: form.address_line1 || undefined,
        address_line2: form.address_line2 || undefined,
        postal_code: form.postal_code || undefined,
        city: form.city || undefined,
        state: form.state || undefined,
        country_code: form.country_code || undefined,
      };
      await customerService.acceptInvitation(token, initialDisplayName.trim(), form.password, profile);
      toast.success(t('customer.acceptInvite.successToast', 'Account created — please log in.'));
      navigate('/customer/login?accepted=1', { replace: true });
    } catch (error: any) {
      if (error.response?.status === 409) {
        setErrors({ form: t('customer.acceptInvite.alreadyExists', 'An account with this email already exists. Please log in instead.') });
      } else if (error.response?.data?.details?.length) {
        setErrors({ password: error.response.data.details.join(' ') });
      } else if (error.response?.status === 400) {
        setErrors({ form: error.response?.data?.error || t('customer.acceptInvite.invalidSubmission', 'Could not create your account.') });
      } else {
        toast.error(t('customer.acceptInvite.generalError', 'Could not create your account. Please try again.'));
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="customer-surface min-h-screen flex items-center justify-center px-4 py-8"
      style={{ backgroundColor: 'var(--color-background, #fafafa)' }}
    >
      <div className="w-full max-w-2xl">
        <div className="text-center mb-8">
          <img
            src={resolvedLogoUrl}
            alt={companyName}
            className="h-16 w-auto object-contain mx-auto mb-4"
          />
          <h1 className="text-2xl font-bold text-theme">
            {t('customer.acceptInvite.title', 'Set up your account')}
          </h1>
          <p className="mt-2 text-sm text-muted-theme">
            {t('customer.acceptInvite.subtitle', 'Confirm or fill in your details. You can edit anything from the profile page later.')}
          </p>
        </div>

        <Card padding="lg">
          {isLookingUp ? (
            <div className="flex justify-center py-8"><Loading size="lg" /></div>
          ) : lookupError || !invitation ? (
            <div className="flex items-start gap-2 text-sm">
              <AlertCircle className="w-5 h-5 mt-0.5 flex-shrink-0 text-red-600" />
              <p className="text-theme">{lookupError}</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-6">
              <div className="flex items-start gap-2 p-3 rounded-lg" style={{ backgroundColor: 'var(--color-elevated, #f5f5f5)' }}>
                <CheckCircle className="w-5 h-5 mt-0.5 flex-shrink-0" style={{ color: 'var(--color-accent)' }} />
                <div className="text-sm text-theme">
                  {t('customer.acceptInvite.emailWillBe', 'Your account email will be ')}
                  <span className="font-medium">{invitation.email}</span>
                  {invitation.invitedBy ? (
                    <>
                      {t('customer.acceptInvite.invitedBy', ', invited by ')}
                      <span className="font-medium">{invitation.invitedBy}</span>
                    </>
                  ) : null}
                  .
                </div>
              </div>

              {errors.form && (
                <div role="alert" className="flex items-start gap-2 p-3 rounded-lg border" style={{ borderColor: 'var(--color-surface-border)' }}>
                  <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0 text-red-600" />
                  <span className="text-sm text-theme">{errors.form}</span>
                </div>
              )}

              {/* Personal — required: display name + password */}
              <section className="space-y-3">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-theme flex items-center gap-2">
                  <UserIcon className="w-4 h-4" />
                  {t('customer.acceptInvite.section.personal', 'Personal')}
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-theme mb-1">
                      {t('customer.profile.field.salutation', 'Salutation')}
                    </label>
                    <select
                      value={form.salutation}
                      onChange={(e) => update('salutation', e.target.value)}
                      className="w-full rounded-lg border px-3 h-10 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
                      style={{
                        backgroundColor: 'var(--color-surface)',
                        borderColor: 'var(--color-surface-border)',
                        color: 'var(--color-text)',
                      }}
                    >
                      {SALUTATION_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{t(o.labelKey, o.fallback)}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-theme mb-1">
                      {t('customer.acceptInvite.displayName', 'Display name')} <span className="text-red-500">*</span>
                    </label>
                    <Input
                      value={form.display_name}
                      onChange={(e) => update('display_name', e.target.value)}
                      error={errors.display_name}
                      autoComplete="name"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-theme mb-1" htmlFor="invite-first-name">
                      {t('customer.profile.field.firstName', 'First name')}
                    </label>
                    <Input
                      id="invite-first-name"
                      name="given-name"
                      autoComplete="given-name"
                      value={form.first_name}
                      onChange={(e) => update('first_name', e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-theme mb-1" htmlFor="invite-last-name">
                      {t('customer.profile.field.lastName', 'Last name')}
                    </label>
                    <Input
                      id="invite-last-name"
                      name="family-name"
                      autoComplete="family-name"
                      value={form.last_name}
                      onChange={(e) => update('last_name', e.target.value)}
                    />
                  </div>
                </div>
              </section>

              {/* Contact — all optional, the photographer will probably
                  appreciate having the phone for last-minute schedule
                  changes but no customer should be blocked on it. */}
              <section className="space-y-3">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-theme flex items-center gap-2">
                  <Phone className="w-4 h-4" />
                  {t('customer.acceptInvite.section.contact', 'Contact & business (optional)')}
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-theme mb-1" htmlFor="invite-phone">
                      {t('customer.profile.field.phone', 'Phone')}
                    </label>
                    <Input
                      id="invite-phone"
                      name="tel"
                      type="tel"
                      autoComplete="tel"
                      value={form.phone}
                      onChange={(e) => update('phone', e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-theme mb-1" htmlFor="invite-company">
                      {t('customer.profile.field.companyName', 'Company name')}
                    </label>
                    <Input
                      id="invite-company"
                      name="organization"
                      autoComplete="organization"
                      value={form.company_name}
                      onChange={(e) => update('company_name', e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-theme mb-1" htmlFor="invite-vat">
                      {t('customer.profile.field.vatId', 'VAT ID')}
                    </label>
                    <Input
                      id="invite-vat"
                      name="vat-id"
                      value={form.vat_id}
                      onChange={(e) => update('vat_id', e.target.value)}
                    />
                  </div>
                </div>
              </section>

              {/* Address */}
              <section className="space-y-3">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-theme flex items-center gap-2">
                  <MapPin className="w-4 h-4" />
                  {t('customer.acceptInvite.section.address', 'Billing address (optional)')}
                </h2>
                {/* Same `name`+`autoComplete` pairing the profile page
                    uses — see CustomerProfilePage for the rationale. */}
                <div className="grid grid-cols-1 sm:grid-cols-6 gap-3">
                  <div className="sm:col-span-6">
                    <label className="block text-sm font-medium text-theme mb-1" htmlFor="invite-address-line1">
                      {t('customer.profile.field.addressLine1', 'Address line 1')}
                    </label>
                    <Input
                      id="invite-address-line1"
                      name="address-line1"
                      autoComplete="billing address-line1"
                      value={form.address_line1}
                      onChange={(e) => update('address_line1', e.target.value)}
                    />
                  </div>
                  <div className="sm:col-span-6">
                    <label className="block text-sm font-medium text-theme mb-1" htmlFor="invite-address-line2">
                      {t('customer.profile.field.addressLine2', 'Address line 2')}
                    </label>
                    <Input
                      id="invite-address-line2"
                      name="address-line2"
                      autoComplete="billing address-line2"
                      value={form.address_line2}
                      onChange={(e) => update('address_line2', e.target.value)}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-sm font-medium text-theme mb-1" htmlFor="invite-postal-code">
                      {t('customer.profile.field.postalCode', 'Postal code')}
                    </label>
                    <Input
                      id="invite-postal-code"
                      name="postal-code"
                      autoComplete="billing postal-code"
                      inputMode="numeric"
                      value={form.postal_code}
                      onChange={(e) => update('postal_code', e.target.value)}
                    />
                  </div>
                  <div className="sm:col-span-3">
                    <label className="block text-sm font-medium text-theme mb-1" htmlFor="invite-city">
                      {t('customer.profile.field.city', 'City')}
                    </label>
                    <Input
                      id="invite-city"
                      name="address-level2"
                      autoComplete="billing address-level2"
                      value={form.city}
                      onChange={(e) => update('city', e.target.value)}
                    />
                  </div>
                  <div className="sm:col-span-1">
                    <label className="block text-sm font-medium text-theme mb-1" htmlFor="invite-country">
                      {t('customer.profile.field.countryCode', 'Country')}
                    </label>
                    <Input
                      id="invite-country"
                      name="country"
                      autoComplete="billing country"
                      placeholder="DE"
                      maxLength={2}
                      value={form.country_code}
                      onChange={(e) => update('country_code', e.target.value.toUpperCase().slice(0, 2))}
                    />
                  </div>
                  <div className="sm:col-span-3">
                    <label className="block text-sm font-medium text-theme mb-1" htmlFor="invite-state">
                      {t('customer.profile.field.state', 'State / region')}
                    </label>
                    <Input
                      id="invite-state"
                      name="address-level1"
                      autoComplete="billing address-level1"
                      value={form.state}
                      onChange={(e) => update('state', e.target.value)}
                    />
                  </div>
                </div>
              </section>

              {/* Password — required */}
              <section className="space-y-3">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-theme flex items-center gap-2">
                  <Lock className="w-4 h-4" />
                  {t('customer.acceptInvite.section.password', 'Choose a password')}
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-theme mb-1">
                      {t('customer.acceptInvite.password', 'Password')} <span className="text-red-500">*</span>
                    </label>
                    <Input
                      type="password"
                      value={form.password}
                      onChange={(e) => update('password', e.target.value)}
                      error={errors.password}
                      autoComplete="new-password"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-theme mb-1">
                      {t('customer.acceptInvite.confirm', 'Confirm password')} <span className="text-red-500">*</span>
                    </label>
                    <Input
                      type="password"
                      value={form.confirm}
                      onChange={(e) => update('confirm', e.target.value)}
                      error={errors.confirm}
                      autoComplete="new-password"
                    />
                  </div>
                </div>
                <p className="text-xs text-muted-theme">
                  {t('customer.acceptInvite.passwordHint', 'At least 8 characters, with one uppercase letter and one number.')}
                </p>
              </section>

              <Button type="submit" variant="primary" size="lg" isLoading={isSubmitting} className="w-full">
                {t('customer.acceptInvite.submit', 'Create account')}
              </Button>
            </form>
          )}
        </Card>
      </div>
    </div>
  );
};

/**
 * Translate the snake_case prefill payload (matches the backend wire shape)
 * into the camelCase-ish form fields the local state uses. Kept inline
 * because it's only ever called once on mount.
 */
function mergePrefillIntoForm(current: FormState, prefill: CustomerProfilePrefill): Partial<FormState> {
  const out: Partial<FormState> = {};
  if (prefill.salutation && !current.salutation) out.salutation = prefill.salutation;
  if (prefill.first_name && !current.first_name) out.first_name = prefill.first_name;
  if (prefill.last_name && !current.last_name) out.last_name = prefill.last_name;
  if (prefill.display_name && !current.display_name) out.display_name = prefill.display_name;
  if (prefill.phone && !current.phone) out.phone = prefill.phone;
  if (prefill.company_name && !current.company_name) out.company_name = prefill.company_name;
  if (prefill.vat_id && !current.vat_id) out.vat_id = prefill.vat_id;
  if (prefill.address_line1 && !current.address_line1) out.address_line1 = prefill.address_line1;
  if (prefill.address_line2 && !current.address_line2) out.address_line2 = prefill.address_line2;
  if (prefill.postal_code && !current.postal_code) out.postal_code = prefill.postal_code;
  if (prefill.city && !current.city) out.city = prefill.city;
  if (prefill.state && !current.state) out.state = prefill.state;
  if (prefill.country_code && !current.country_code) out.country_code = prefill.country_code;
  return out;
}

export default CustomerAcceptInvitePage;
