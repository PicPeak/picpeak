/**
 * The website's contact form settings in the Design panel (issue 2618): who
 * is mailed a new message, the visitor's confirmation (only with a spam
 * check), and the spam check (Friendly Captcha with its own keys, or
 * reCAPTCHA with the keys of Settings › Security). The draft lives on the
 * builder page (contactSettingsDraft.ts) and is saved through its save bar;
 * these settings apply as soon as they are saved, not with the website's
 * draft. The API key is never shown again; typing one replaces it. Both
 * mails are email templates, linked from here.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Notice, Switch } from '../../components/common';
import { settingsTabHref } from '../settings/settingsNav';
import type { CaptchaProvider } from '../../services/website.service';
import type { ContactSettingsDraft } from './contactSettingsDraft';
import { ChoiceField, TextField } from './fields';

const templateHref = (key: string) => `${settingsTabHref('email')}&template=${key}`;

export const ContactSettingsSection: React.FC<{ settings: ContactSettingsDraft; readOnly: boolean }> = ({ settings, readOnly: draftReadOnly }) => {
  const { t } = useTranslation();
  // Where visitors' messages go is a studio setting (server: settings.edit).
  const readOnly = draftReadOnly || !settings.canChange;
  const data = settings.server;
  const draft = settings.draft;
  const set = settings.set;
  if (!data || !draft) return null;
  return (
    <section className="space-y-4 border-t border-line pt-5">
      <div>
        <h3 className="text-sm font-semibold text-heading flex items-center gap-2">
          {t('website.contact.title', 'Contact form')}
          {settings.dirty && <span className="inline-flex items-center gap-1 text-xs font-normal text-warning-text"><span className="w-2 h-2 rounded-full bg-warning" aria-hidden="true" />{t('website.contact.unsaved', 'not saved yet')}</span>}
        </h3>
        <p className="text-xs text-muted">{t('website.contact.intro', 'For every contact form on the website. Saved with the bar below, and in effect at once, not with the draft.')}</p>
      </div>
      {settings.conflict && (
        <Notice tone="warning" size="sm" action={(
          <button type="button" className="text-sm font-medium text-accent hover:underline" onClick={() => { void settings.loadLatest(); }}>
            {t('website.contact.loadLatest', 'Load the latest')}
          </button>
        )}>
          {t('website.contact.conflict', 'Someone else changed these settings meanwhile. Load the latest and make your change again.')}
        </Notice>
      )}
      <fieldset disabled={readOnly} className="space-y-4">
        <legend className="sr-only">{t('website.contact.title', 'Contact form')}</legend>
        <div className="space-y-1">
          <TextField label={t('website.contact.recipients', 'Send new messages to')} value={draft.recipients} maxLength={1300}
            placeholder={data.contact.defaultRecipient}
            helperText={t('website.contact.recipientsHint', 'Up to five addresses, separated by commas. Empty: the business address, else the support address. Every message is in Messages › Customers as well.')}
            onChange={(recipients) => set({ recipients })} />
          <Link to={templateHref('website_contact_admin')} className="text-xs text-accent hover:underline">{t('website.contact.editAdminMail', 'Edit the notification mail')}</Link>
        </div>
        <ChoiceField label={t('website.contact.captcha', 'Spam check')} value={draft.provider}
          options={[
            { value: 'none', label: t('website.contact.captchaNone', 'Off') },
            { value: 'friendly', label: 'Friendly Captcha' },
            { value: 'recaptcha', label: 'Google reCAPTCHA' },
          ]}
          onChange={(v) => set({ provider: v as CaptchaProvider })} />
        <p className="text-xs text-muted">
          {t('website.contact.captchaHint', 'The form always has a hidden trap field and a limit per sender. A spam check adds the provider’s widget to pages with a contact form, and only those pages load its script. Friendly Captcha needs no cookies.')}
        </p>
        {draft.provider === 'friendly' && (
          <div className="space-y-3">
            {data.captcha.friendly.apiKeyUnreadable && (
              <Notice tone="warning" size="sm">
                {t('website.contact.apiKeyUnreadable', 'The saved API key can no longer be read (the server’s secret key changed). Enter the API key again: the contact form refuses messages until it is.')}
              </Notice>
            )}
            <TextField label={t('website.contact.siteKey', 'Site key')} value={draft.siteKey} maxLength={100} onChange={(siteKey) => set({ siteKey })} />
            <TextField label={t('website.contact.apiKey', 'API key')} value={draft.apiKey} maxLength={200} type="password"
              placeholder={data.captcha.friendly.apiKeySet ? t('website.contact.apiKeySaved', 'Saved. Type a new one to replace it.') as string : ''}
              onChange={(apiKey) => set({ apiKey })} />
            <ChoiceField label={t('website.contact.endpoint', 'Where the check runs')} value={draft.endpoint}
              options={[
                { value: 'global', label: t('website.contact.endpointGlobal', 'Worldwide') },
                { value: 'eu', label: t('website.contact.endpointEu', 'Servers in the EU') },
              ]}
              onChange={(v) => set({ endpoint: v as 'global' | 'eu' })} />
            <p className="text-xs text-muted">{t('website.contact.endpointHint', 'The EU servers are part of Friendly Captcha’s paid plans; choose them only if your plan includes them.')}</p>
          </div>
        )}
        {draft.provider === 'recaptcha' && (
          <Notice tone={data.captcha.recaptchaReady ? 'info' : 'warning'} size="sm">
            {data.captcha.recaptchaReady
              ? t('website.contact.recaptchaReady', 'Uses the reCAPTCHA keys of ')
              : t('website.contact.recaptchaMissing', 'Enter the reCAPTCHA site key and secret first, in ')}
            <Link to={settingsTabHref('security')} className="font-medium underline">{t('website.contact.securityLink', 'Settings › Security')}</Link>.
          </Notice>
        )}
        <div className="space-y-1">
          <Switch checked={draft.confirmation && draft.provider !== 'none'} disabled={draft.provider === 'none'} onChange={(confirmation) => set({ confirmation })}
            label={t('website.contact.confirmation', 'Send the visitor a confirmation')}
            description={draft.provider === 'none'
              ? t('website.contact.confirmationNeedsCaptcha', 'Only with a spam check: without one, anyone could have it sent to any address.')
              : t('website.contact.confirmationHint', 'Their name and your fixed text, never their message; at most one a day to an address.')} />
          <Link to={templateHref('website_contact_confirmation')} className="text-xs text-accent hover:underline">{t('website.contact.editConfirmationMail', 'Edit the confirmation mail')}</Link>
        </div>
      </fieldset>
    </section>
  );
};
