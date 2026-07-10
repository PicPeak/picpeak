import React, { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { Save, Send, Eye, EyeOff, ChevronUp, ChevronDown } from 'lucide-react';
import { Button, Card, CardContent, Input, Loading } from '../../../components/common';
import {
  whatsappService,
  WHATSAPP_TEMPLATE_PARAMS,
  type WhatsAppTemplateParam,
} from '../../../services/whatsapp.service';

/**
 * WhatsApp Business API configuration tab (#640D).
 *
 * Stores the Meta phone_number_id + waba_id + access_token + approved
 * template_name. Access token is masked on GET (server returns '********');
 * the PUT silently preserves the stored token when the user doesn't supply
 * a fresh one — they can edit other fields without re-entering it. Enabling
 * with no token (and none stored) fails at the route validator.
 *
 * The Test action fires a static template message at a phone the admin
 * provides — useful to verify the credentials + template approval state
 * without waiting for a real event-published trigger.
 */
export const WhatsAppTab: React.FC = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['whatsapp-config'],
    queryFn: () => whatsappService.getConfig(),
  });

  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [templateName, setTemplateName] = useState('gallery_ready');
  const [templateLanguage, setTemplateLanguage] = useState('');
  const [templateParams, setTemplateParams] = useState<WhatsAppTemplateParam[]>(
    [...WHATSAPP_TEMPLATE_PARAMS],
  );
  const [enabled, setEnabled] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [testPhone, setTestPhone] = useState('');

  useEffect(() => {
    if (data) {
      setPhoneNumberId(data.phone_number_id || '');
      setWabaId(data.waba_id || '');
      // Server returns '********' when a token is stored, '' when none is.
      // Leave it visible-as-masked so the admin sees that a token exists.
      setAccessToken(data.access_token || '');
      setTemplateName(data.template_name || 'gallery_ready');
      setTemplateLanguage(data.template_language || '');
      // The server always returns a non-empty sanitized array (default 5-slot
      // shape when the column is empty), so we can take it directly.
      setTemplateParams(
        data.template_params && data.template_params.length > 0
          ? data.template_params
          : [...WHATSAPP_TEMPLATE_PARAMS],
      );
      setEnabled(Boolean(data.enabled));
    }
  }, [data]);

  // Toggle inclusion of a slot. When checked we append at the end (highest
  // {{N}}); when unchecked we drop it from the list. Reordering uses the
  // up/down buttons below.
  const toggleParam = (key: WhatsAppTemplateParam) => {
    setTemplateParams((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  };

  const moveParam = (idx: number, delta: -1 | 1) => {
    setTemplateParams((prev) => {
      const target = idx + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  };

  const save = useMutation({
    mutationFn: () => whatsappService.updateConfig({
      phone_number_id: phoneNumberId,
      waba_id: wabaId,
      access_token: accessToken,
      template_name: templateName,
      template_language: templateLanguage,
      template_params: templateParams,
      enabled,
    }),
    onSuccess: () => {
      toast.success(t('settings.whatsapp.savedToast', 'WhatsApp settings saved.'));
      qc.invalidateQueries({ queryKey: ['whatsapp-config'] });
    },
    onError: (e: any) => {
      toast.error(e?.response?.data?.error || e.message || 'Save failed');
    },
  });

  const sendTest = useMutation({
    mutationFn: () => whatsappService.sendTest(testPhone),
    onSuccess: (r) => {
      toast.success(
        t('settings.whatsapp.testSentToast', 'Test message sent (id: {{id}}).', {
          id: r.messageId || 'unknown',
        }),
      );
    },
    onError: (e: any) => {
      toast.error(e?.response?.data?.error || e.message || 'Test send failed');
    },
  });

  if (isLoading) return <Loading />;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-neutral-900 dark:text-neutral-100">
          {t('settings.whatsapp.title', 'WhatsApp')}
        </h2>
        <p className="text-neutral-600 dark:text-neutral-400 mt-1">
          {t(
            'settings.whatsapp.subtitle',
            'Configure Meta Business credentials to deliver the gallery-ready notification via WhatsApp alongside email.',
          )}
        </p>
      </div>

      <Card>
        <CardContent className="p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              {t('settings.whatsapp.phoneNumberId', 'Phone Number ID')}
            </label>
            <Input
              value={phoneNumberId}
              onChange={(e) => setPhoneNumberId(e.target.value)}
              placeholder="123456789012345"
            />
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              {t(
                'settings.whatsapp.phoneNumberIdHint',
                'From Meta Business → WhatsApp → API Setup. The numeric ID Meta assigns to the phone you registered.',
              )}
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              {t('settings.whatsapp.wabaId', 'WABA ID')}
            </label>
            <Input
              value={wabaId}
              onChange={(e) => setWabaId(e.target.value)}
              placeholder="123456789012345"
            />
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              {t(
                'settings.whatsapp.wabaIdHint',
                'WhatsApp Business Account ID. Reference only (the API call uses the Phone Number ID); helpful for auditing.',
              )}
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              {t('settings.whatsapp.accessToken', 'Access token')}
            </label>
            <Input
              type={showToken ? 'text' : 'password'}
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              placeholder={t('settings.whatsapp.accessTokenPlaceholder', 'EAAB… (system-user token recommended)') as string}
              rightIcon={
                <button
                  type="button"
                  onClick={() => setShowToken((v) => !v)}
                  className="p-1"
                  aria-label={showToken ? t('common.hide', 'Hide') : t('common.show', 'Show')}
                >
                  {showToken ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                </button>
              }
            />
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              {t(
                'settings.whatsapp.accessTokenHint',
                'Stored masked as "********" on GET. Leave the masked value to keep the existing token; type a new one to replace it.',
              )}
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              {t('settings.whatsapp.templateName', 'Template name')}
            </label>
            <Input
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              placeholder="gallery_ready"
            />
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              {t(
                'settings.whatsapp.templateNameHint',
                'Name of the Meta-approved message template. The default `gallery_ready` expects 5 body parameters: customer name, event name, gallery link, password line, expiry date. Approve the template in Meta Business Manager before enabling.',
              )}
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              {t('settings.whatsapp.templateLanguage', 'Template language')}
            </label>
            <Input
              value={templateLanguage}
              onChange={(e) => setTemplateLanguage(e.target.value)}
              placeholder={t('settings.whatsapp.templateLanguagePlaceholder', 'e.g. en_US, de_DE, ar, pt_BR') as string}
            />
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              {t(
                'settings.whatsapp.templateLanguageHint',
                'Meta template language code, exactly as you registered it in Meta Business Manager (`ar`, `en_US`, `de_DE`, `pt_BR`, etc.). Leave empty to fall back to the system default language. Meta returns "template not found in language" if this doesn\'t match a registered template.',
              )}
            </p>
          </div>

          {/* Template parameter selection (#647 follow-up). Reporter's
              template uses only event_name + gallery_link, but the legacy
              shape hardcoded a 5-parameter `gallery_ready` payload that Meta
              rejected with a parameter-count mismatch. This control lets the
              admin pick which slots to send and in what positional order. */}
          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              {t('settings.whatsapp.templateParams', 'Template parameters')}
            </label>
            <p className="mb-2 text-xs text-neutral-500 dark:text-neutral-400">
              {t(
                'settings.whatsapp.templateParamsHint',
                'Pick which built-in values are sent as positional template parameters (slot 1, slot 2, …), and arrange them so they match the order in your Meta-registered template body. Unchecked slots are not sent at all. Default matches the built-in `gallery_ready` 5-parameter shape.',
              )}
            </p>
            <ul className="rounded-lg border border-neutral-200 dark:border-neutral-700 divide-y divide-neutral-200 dark:divide-neutral-700">
              {WHATSAPP_TEMPLATE_PARAMS.map((slot) => {
                const idx = templateParams.indexOf(slot);
                const included = idx >= 0;
                return (
                  <li
                    key={slot}
                    className="flex items-center gap-3 p-3 bg-white dark:bg-neutral-900"
                  >
                    <input
                      type="checkbox"
                      checked={included}
                      onChange={() => toggleParam(slot)}
                      className="rounded border-neutral-300"
                      aria-label={t(`settings.whatsapp.params.${slot}`, slot) as string}
                    />
                    <span className="flex-1 text-sm text-neutral-800 dark:text-neutral-200">
                      <span className="font-mono text-xs text-neutral-500 dark:text-neutral-400 mr-2">
                        {included ? `{{${idx + 1}}}` : '—'}
                      </span>
                      {t(`settings.whatsapp.params.${slot}`, slot)}
                    </span>
                    {included && (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => moveParam(idx, -1)}
                          disabled={idx === 0}
                          className="p-1 disabled:opacity-30"
                          aria-label={t('settings.whatsapp.paramMoveUp', 'Move up') as string}
                        >
                          <ChevronUp className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => moveParam(idx, 1)}
                          disabled={idx === templateParams.length - 1}
                          className="p-1 disabled:opacity-30"
                          aria-label={t('settings.whatsapp.paramMoveDown', 'Move down') as string}
                        >
                          <ChevronDown className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
              {templateParams.length === 0
                ? t(
                  'settings.whatsapp.templateParamsEmpty',
                  'No slots selected — saving will fall back to the default 5-parameter shape.',
                )
                : t('settings.whatsapp.templateParamsPreview', 'Your template will receive: {{preview}}', {
                  preview: templateParams.map((slot, i) => `{{${i + 1}}} = ${slot}`).join(', '),
                })}
            </p>
          </div>

          <label className="flex items-center gap-2 text-sm text-neutral-800 dark:text-neutral-200">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="rounded border-neutral-300"
            />
            {t('settings.whatsapp.enabled', 'Send WhatsApp notifications')}
          </label>

          <Button
            onClick={() => save.mutate()}
            disabled={save.isPending}
            leftIcon={<Save className="w-4 h-4" />}
          >
            {save.isPending ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
          </Button>
        </CardContent>
      </Card>

      {/* Test send card — separate so the admin sees it as a distinct action,
          not a sub-step of saving. */}
      <Card>
        <CardContent className="p-5 space-y-3">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
            {t('settings.whatsapp.testHeading', 'Send a test message')}
          </h3>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {t(
              'settings.whatsapp.testHelp',
              'Sends a static template message to the phone number below to verify Meta credentials + template approval. Includes country code (e.g. +49…).',
            )}
          </p>
          <div className="flex gap-2 items-start">
            <Input
              value={testPhone}
              onChange={(e) => setTestPhone(e.target.value)}
              placeholder="+49123456789"
              className="max-w-xs"
            />
            <Button
              variant="outline"
              onClick={() => sendTest.mutate()}
              disabled={!testPhone.trim() || sendTest.isPending}
              leftIcon={<Send className="w-4 h-4" />}
            >
              {sendTest.isPending
                ? t('settings.whatsapp.testSending', 'Sending…')
                : t('settings.whatsapp.testSend', 'Send test')}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default WhatsAppTab;
