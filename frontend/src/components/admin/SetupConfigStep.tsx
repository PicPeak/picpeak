import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { ShieldAlert } from 'lucide-react';

import { Button, Input, Notice } from '../common';
import type { FeatureKey } from '../../services/featureFlags.service';
import { businessProfileService } from '../../services/businessProfile.service';
import { emailService, type EmailConfig } from '../../services/email.service';
import { settingsService } from '../../services/settings.service';
import { isAbsoluteHttpUrl } from '../../utils/url';

// Email is NOT feature-gated (#705): a gallery-only install still mails the
// gallery link, guest invites and expiry warnings through the same
// email_configs row, so hiding SMTP behind the CRM-ish features left the most
// basic install unable to deliver anything.

interface Props {
  selectedFeatures: Set<FeatureKey>;
  onDone: () => void;
}

// Lean per-feature config, shown after the "How will you use PicPeak?" step.
// Only the sections a selected feature actually needs are rendered; everything
// else keeps its seeded defaults and is tunable later in Settings. Every field
// is optional — "Skip for now" always leaves — but a section the user DID fill
// in is validated before it is posted, and a save that fails keeps them on the
// step with their input intact rather than advancing into a silent data loss.
export const SetupConfigStep: React.FC<Props> = ({ selectedFeatures, onDone }) => {
  const { t } = useTranslation();
  const showInvoicing = selectedFeatures.has('bills');
  const [saving, setSaving] = useState(false);

  const [inv, setInv] = useState({
    companyName: '', addressLine1: '', postalCode: '', city: '', countryCode: '',
    vatId: '', taxId: '', defaultCurrency: 'CHF', iban: '',
  });
  const [mail, setMail] = useState({
    smtp_host: '', smtp_port: '587', smtp_user: '', smtp_pass: '', from_email: '', from_name: '',
  });
  // Prefilled with the address the admin actually reached the wizard on, which
  // on a NAS or LAN install is the one thing no default can guess (#705).
  const [siteUrl, setSiteUrl] = useState(window.location.origin.replace(/\/+$/, ''));
  const [errors, setErrors] = useState<Record<string, string>>({});

  const invField = (k: keyof typeof inv) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setInv((p) => ({ ...p, [k]: e.target.value }));
  const mailField = (k: keyof typeof mail) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setMail((p) => ({ ...p, [k]: e.target.value }));

  // Persist the public origin on BOTH paths — skipping the optional invoicing
  // and SMTP sections must not also skip the address that every gallery link,
  // QR code and reminder email is built from.
  //
  // Throws rather than swallowing: PUT /general applies its own URL check, and
  // a rejection here means the wizard would otherwise finish reporting success
  // with no public address stored at all — the silent misconfiguration this
  // whole change exists to remove. Callers decide what to do with it.
  const saveSiteUrl = async () => {
    const value = siteUrl.trim().replace(/\/+$/, '');
    if (!value) return;
    await settingsService.updateSettings({ general_site_url: value });
  };

  const siteUrlRejected = () => t(
    'setup.config.siteUrlRejected',
    'The server rejected this address. Use the full origin, for example https://gallery.example.com or http://192.168.1.50:3000.',
  );

  // Blocking validation, run before anything is posted. Everything on this
  // step is optional, but a value that IS filled in has to be usable: the
  // public address feeds the CORS allowlist (#705), and /admin/email/config
  // rejects a config whose from_email isn't a valid address — which used to
  // surface as a generic warning while the wizard advanced anyway, throwing
  // away every SMTP value including the password (#1104).
  const validate = () => {
    const next: Record<string, string> = {};
    if (siteUrl.trim() && !isAbsoluteHttpUrl(siteUrl)) {
      next.siteUrl = t('setup.config.siteUrlInvalid', 'Enter the full address including http:// or https://, for example https://gallery.example.com');
    }
    if (mail.smtp_host.trim()) {
      const from = mail.from_email.trim();
      if (!from) {
        next.from_email = t('setup.config.fromEmailRequired', 'A From address is required when an SMTP host is set.');
      } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) {
        next.from_email = t('setup.config.fromEmailInvalid', 'Enter a valid email address.');
      }
      const port = parseInt(mail.smtp_port, 10);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        next.smtp_port = t('setup.config.smtpPortInvalid', 'Enter a port between 1 and 65535.');
      }
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const skip = async () => {
    if (siteUrl.trim() && !isAbsoluteHttpUrl(siteUrl)) {
      setErrors({ siteUrl: t('setup.config.siteUrlInvalid', 'Enter the full address including http:// or https://, for example https://gallery.example.com') });
      return;
    }
    setErrors({});
    setSaving(true);
    // "Skip for now" always leaves, by contract — but say so rather than
    // dropping the address without a word.
    try {
      await saveSiteUrl();
    } catch {
      toast.warn(siteUrlRejected());
    }
    setSaving(false);
    onDone();
  };

  const finish = async () => {
    if (!validate()) return;
    setSaving(true);
    let failed = false;

    // Separate from the block below so the message lands on the address field
    // instead of the generic "some settings could not be saved" warning. The
    // server check is stricter than isAbsoluteHttpUrl in places, so this is
    // reachable even after validate() has passed.
    try {
      await saveSiteUrl();
    } catch {
      setSaving(false);
      setErrors((prev) => ({ ...prev, siteUrl: siteUrlRejected() }));
      return;
    }

    try {
      // Invoicing: only persist if they actually started filling it in.
      if (showInvoicing && inv.companyName.trim()) {
        await businessProfileService.update({
          companyName: inv.companyName.trim(),
          addressLine1: inv.addressLine1.trim(),
          postalCode: inv.postalCode.trim(),
          city: inv.city.trim(),
          countryCode: inv.countryCode.trim(),
          vatId: inv.vatId.trim(),
          taxId: inv.taxId.trim(),
          defaultCurrency: inv.defaultCurrency.trim() || 'CHF',
        });
        if (inv.iban.trim()) {
          await businessProfileService.createBankAccount({
            iban: inv.iban.replace(/\s+/g, ''),
            accountHolder: inv.companyName.trim(),
            currency: inv.defaultCurrency.trim() || 'CHF',
            isDefault: true,
          });
        }
      }
      // Email: only persist if a host was entered.
      if (mail.smtp_host.trim()) {
        const port = parseInt(mail.smtp_port, 10) || 587;
        const config: EmailConfig = {
          smtp_host: mail.smtp_host.trim(),
          smtp_port: port,
          smtp_secure: port === 465,
          smtp_user: mail.smtp_user.trim(),
          smtp_pass: mail.smtp_pass,
          from_email: mail.from_email.trim(),
          from_name: mail.from_name.trim(),
          tls_reject_unauthorized: true,
        };
        await emailService.updateConfig(config);
      }
    } catch {
      // Stay on the step: advancing here discarded everything the user typed,
      // the SMTP password included, with no way back to re-enter it (#1104).
      failed = true;
      toast.warn(t('setup.config.saveFailed', 'Some settings could not be saved — check the values below, or use “Skip for now” and finish in Settings.'));
    } finally {
      setSaving(false);
    }
    if (!failed) onDone();
  };

  return (
    <div className="space-y-8">
      <p className="rounded-lg bg-subtle border border-line px-3 py-2 text-xs text-soft">
        {t('setup.config.intro', 'A few details to finish setting up. Anything you skip keeps its default and can be set later in Settings.')}
      </p>

      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-heading">
          {t('setup.config.siteUrl', 'Public address')}
        </h3>
        <p className="text-xs text-muted">
          {t('setup.config.siteUrlHint', 'Where your clients will reach this gallery. Prefilled with the address you opened right now — change it if you will put PicPeak behind a domain or reverse proxy. You can update this any time in Settings → General.')}
        </p>
        <Input
          type="url"
          placeholder="https://gallery.example.com"
          value={siteUrl}
          onChange={(e) => setSiteUrl(e.target.value)}
          error={errors.siteUrl}
        />
      </div>

      {showInvoicing && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-heading">{t('setup.config.invoicing', 'Invoicing details')}</h3>
          <Notice tone="warning" size="sm" icon={<ShieldAlert className="h-4 w-4" />}>
            {t('setup.config.invoicingDisclaimer', 'Used on your invoices. Bank/IBAN and VAT details are your responsibility — verify them with your bank and Treuhänder/tax advisor.')}
          </Notice>
          <Input placeholder={t('setup.config.companyName', 'Company / legal name')} value={inv.companyName} onChange={invField('companyName')} />
          <Input placeholder={t('setup.config.addressLine1', 'Street and number')} value={inv.addressLine1} onChange={invField('addressLine1')} />
          <div className="grid grid-cols-3 gap-3">
            <Input placeholder={t('setup.config.postalCode', 'Postal code')} value={inv.postalCode} onChange={invField('postalCode')} />
            <div className="col-span-2"><Input placeholder={t('setup.config.city', 'City')} value={inv.city} onChange={invField('city')} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input placeholder={t('setup.config.countryCode', 'Country code (e.g. CH)')} value={inv.countryCode} onChange={invField('countryCode')} />
            <Input placeholder={t('setup.config.currency', 'Currency (e.g. CHF)')} value={inv.defaultCurrency} onChange={invField('defaultCurrency')} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input placeholder={t('setup.config.vatId', 'VAT ID (or leave blank)')} value={inv.vatId} onChange={invField('vatId')} />
            <Input placeholder={t('setup.config.taxId', 'Tax number (or VAT ID)')} value={inv.taxId} onChange={invField('taxId')} />
          </div>
          <Input placeholder={t('setup.config.iban', 'IBAN (for invoice payments)')} value={inv.iban} onChange={invField('iban')} />
        </div>
      )}

      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-heading">{t('setup.config.email', 'Email delivery (SMTP)')}</h3>
        <p className="text-xs text-muted">{t('setup.config.emailHint', 'Used to send gallery links to your clients, plus guest invites, expiry warnings and any reminders or invoices you enable. Leave blank to set it up later in Settings → Email.')}</p>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2"><Input placeholder={t('setup.config.smtpHost', 'SMTP host')} value={mail.smtp_host} onChange={mailField('smtp_host')} /></div>
            <Input placeholder={t('setup.config.smtpPort', 'Port')} value={mail.smtp_port} onChange={mailField('smtp_port')} error={errors.smtp_port} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input placeholder={t('setup.config.smtpUser', 'Username')} value={mail.smtp_user} onChange={mailField('smtp_user')} autoComplete="off" />
            <Input type="password" placeholder={t('setup.config.smtpPass', 'Password')} value={mail.smtp_pass} onChange={mailField('smtp_pass')} autoComplete="new-password" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input
              type="email"
              placeholder={mail.smtp_host.trim()
                ? t('setup.config.fromEmailRequiredPlaceholder', 'From address (required)')
                : t('setup.config.fromEmail', 'From address')}
              value={mail.from_email}
              onChange={mailField('from_email')}
              error={errors.from_email}
            />
            <Input placeholder={t('setup.config.fromName', 'From name')} value={mail.from_name} onChange={mailField('from_name')} />
          </div>
      </div>

      <div className="flex gap-3">
        <Button type="button" variant="outline" size="lg" onClick={skip} disabled={saving}>
          {t('setup.config.skip', 'Skip for now')}
        </Button>
        <Button type="button" variant="primary" size="lg" isLoading={saving} className="flex-1" onClick={finish}>
          {t('setup.config.finish', 'Finish setup')}
        </Button>
      </div>
    </div>
  );
};

SetupConfigStep.displayName = 'SetupConfigStep';
