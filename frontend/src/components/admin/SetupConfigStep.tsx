import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { ShieldAlert } from 'lucide-react';

import { Button, Input } from '../common';
import type { FeatureKey } from '../../services/featureFlags.service';
import { businessProfileService } from '../../services/businessProfile.service';
import { emailService, type EmailConfig } from '../../services/email.service';

// Features that need working SMTP to deliver anything.
const EMAIL_FEATURES: FeatureKey[] = ['reminderEmails', 'incomingMail', 'whatsapp', 'bills'];

interface Props {
  selectedFeatures: Set<FeatureKey>;
  onDone: () => void;
}

// Lean per-feature config, shown after the "How will you use PicPeak?" step.
// Only the sections a selected feature actually needs are rendered; everything
// else keeps its seeded defaults and is tunable later in Settings. Saving is
// best-effort per section — a failure never traps the user on setup.
export const SetupConfigStep: React.FC<Props> = ({ selectedFeatures, onDone }) => {
  const { t } = useTranslation();
  const showInvoicing = selectedFeatures.has('bills');
  const showEmail = EMAIL_FEATURES.some((f) => selectedFeatures.has(f));
  const [saving, setSaving] = useState(false);

  const [inv, setInv] = useState({
    companyName: '', addressLine1: '', postalCode: '', city: '', countryCode: '',
    vatId: '', taxId: '', defaultCurrency: 'CHF', iban: '',
  });
  const [mail, setMail] = useState({
    smtp_host: '', smtp_port: '587', smtp_user: '', smtp_pass: '', from_email: '', from_name: '',
  });

  const invField = (k: keyof typeof inv) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setInv((p) => ({ ...p, [k]: e.target.value }));
  const mailField = (k: keyof typeof mail) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setMail((p) => ({ ...p, [k]: e.target.value }));

  const finish = async () => {
    setSaving(true);
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
      if (showEmail && mail.smtp_host.trim()) {
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
    } catch (_) {
      toast.warn(t('setup.config.saveFailed', 'Some settings could not be saved — you can finish them in Settings.'));
    } finally {
      setSaving(false);
      onDone();
    }
  };

  return (
    <div className="space-y-8">
      <p className="rounded-lg bg-neutral-50 border border-neutral-200 px-3 py-2 text-xs text-neutral-600">
        {t('setup.config.intro', 'A few details for the features you picked. Anything you skip keeps its default and can be set later in Settings.')}
      </p>

      {showInvoicing && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-neutral-800">{t('setup.config.invoicing', 'Invoicing details')}</h3>
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
            <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600" />
            <p className="text-xs text-amber-800">
              {t('setup.config.invoicingDisclaimer', 'Used on your invoices. Bank/IBAN and VAT details are your responsibility — verify them with your bank and Treuhänder/tax advisor.')}
            </p>
          </div>
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

      {showEmail && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-neutral-800">{t('setup.config.email', 'Email delivery (SMTP)')}</h3>
          <p className="text-xs text-neutral-500">{t('setup.config.emailHint', 'Required to send reminders, invoices and notifications.')}</p>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2"><Input placeholder={t('setup.config.smtpHost', 'SMTP host')} value={mail.smtp_host} onChange={mailField('smtp_host')} /></div>
            <Input placeholder={t('setup.config.smtpPort', 'Port')} value={mail.smtp_port} onChange={mailField('smtp_port')} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input placeholder={t('setup.config.smtpUser', 'Username')} value={mail.smtp_user} onChange={mailField('smtp_user')} autoComplete="off" />
            <Input type="password" placeholder={t('setup.config.smtpPass', 'Password')} value={mail.smtp_pass} onChange={mailField('smtp_pass')} autoComplete="new-password" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input type="email" placeholder={t('setup.config.fromEmail', 'From address')} value={mail.from_email} onChange={mailField('from_email')} />
            <Input placeholder={t('setup.config.fromName', 'From name')} value={mail.from_name} onChange={mailField('from_name')} />
          </div>
        </div>
      )}

      <div className="flex gap-3">
        <Button type="button" variant="outline" size="lg" onClick={onDone} disabled={saving}>
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
