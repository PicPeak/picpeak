/**
 * The website's contact form settings in the Design panel (issue 2618),
 * saved right away, not part of the draft: the spam check (Friendly Captcha
 * with its own keys, or reCAPTCHA with the keys of Settings › Security).
 * The API key is never shown again; typing one replaces it.
 */
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { Button, Notice } from '../../components/common';
import { settingsTabHref } from '../settings/settingsNav';
import { websiteService, type CaptchaProvider, type ContactSettings } from '../../services/website.service';
import { apiErrorText } from '../../utils/apiErrorText';
import { ChoiceField, TextField } from './fields';

const QUERY_KEY = ['website-contact-settings'];

export const ContactSettingsSection: React.FC<{ readOnly: boolean }> = ({ readOnly }) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: QUERY_KEY, queryFn: websiteService.getContactSettings });
  const [provider, setProvider] = useState<CaptchaProvider>('none');
  const [siteKey, setSiteKey] = useState('');
  const [endpoint, setEndpoint] = useState<'global' | 'eu'>('global');
  const [apiKey, setApiKey] = useState('');
  useEffect(() => {
    if (!data) return;
    setProvider(data.captcha.provider);
    setSiteKey(data.captcha.friendly.siteKey);
    setEndpoint(data.captcha.friendly.endpoint);
    setApiKey('');
  }, [data]);

  const save = useMutation({
    mutationFn: () => websiteService.saveContactSettings({
      captcha: { provider, friendly: { siteKey: siteKey.trim(), endpoint, ...(apiKey ? { apiKey: apiKey.trim() } : {}) } },
    }),
    onSuccess: (next: ContactSettings) => {
      queryClient.setQueryData(QUERY_KEY, next);
      // The preview's and the live pages' forms change with it.
      void queryClient.invalidateQueries({ queryKey: ['website-preview'] });
      toast.success(t('website.contact.saved', 'Contact form settings saved'));
    },
    onError: (err) => toast.error(apiErrorText(err)),
  });

  if (!data) return null;
  return (
    <section className="space-y-4 border-t border-line pt-5">
      <div>
        <h3 className="text-sm font-semibold text-heading">{t('website.contact.title', 'Contact form')}</h3>
        <p className="text-xs text-muted">{t('website.contact.intro', 'For every contact form on the website. Saved right away, not with the draft.')}</p>
      </div>
      <fieldset disabled={readOnly} className="space-y-4">
        <legend className="sr-only">{t('website.contact.title', 'Contact form')}</legend>
        <ChoiceField label={t('website.contact.captcha', 'Spam check')} value={provider}
          options={[
            { value: 'none', label: t('website.contact.captchaNone', 'Off') },
            { value: 'friendly', label: 'Friendly Captcha' },
            { value: 'recaptcha', label: 'Google reCAPTCHA' },
          ]}
          onChange={(v) => setProvider(v as CaptchaProvider)} />
        <p className="text-xs text-muted">
          {t('website.contact.captchaHint', 'The form always has a hidden trap field and a limit per sender. A spam check adds the provider’s widget to pages with a contact form, and only those pages load its script. Friendly Captcha needs no cookies.')}
        </p>
        {provider === 'friendly' && (
          <div className="space-y-3">
            <TextField label={t('website.contact.siteKey', 'Site key')} value={siteKey} maxLength={100} onChange={setSiteKey} />
            <TextField label={t('website.contact.apiKey', 'API key')} value={apiKey} maxLength={200} type="password"
              placeholder={data.captcha.friendly.apiKeySet ? t('website.contact.apiKeySaved', 'Saved. Type a new one to replace it.') as string : ''}
              onChange={setApiKey} />
            <ChoiceField label={t('website.contact.endpoint', 'Where the check runs')} value={endpoint}
              options={[
                { value: 'global', label: t('website.contact.endpointGlobal', 'Worldwide') },
                { value: 'eu', label: t('website.contact.endpointEu', 'Servers in the EU') },
              ]}
              onChange={(v) => setEndpoint(v as 'global' | 'eu')} />
            <p className="text-xs text-muted">{t('website.contact.endpointHint', 'The EU servers are part of Friendly Captcha’s paid plans; choose them only if your plan includes them.')}</p>
          </div>
        )}
        {provider === 'recaptcha' && (
          <Notice tone={data.captcha.recaptchaReady ? 'info' : 'warning'} size="sm">
            {data.captcha.recaptchaReady
              ? t('website.contact.recaptchaReady', 'Uses the reCAPTCHA keys of ')
              : t('website.contact.recaptchaMissing', 'Enter the reCAPTCHA site key and secret first, in ')}
            <Link to={settingsTabHref('security')} className="font-medium underline">{t('website.contact.securityLink', 'Settings › Security')}</Link>.
          </Notice>
        )}
        {!readOnly && (
          <Button size="sm" variant="primary" isLoading={save.isPending} onClick={() => save.mutate()}>
            {t('website.contact.save', 'Save contact form settings')}
          </Button>
        )}
      </fieldset>
    </section>
  );
};
