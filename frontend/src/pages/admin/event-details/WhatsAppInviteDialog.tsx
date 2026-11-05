/**
 * Send a gallery link through the admin's own WhatsApp, with their own text,
 * instead of the automatic email. Opens a wa.me click-to-chat link; nothing
 * goes through the server or the WhatsApp Business channel (that one only
 * carries approved templates), so it works with the `whatsapp` flag off.
 *
 * The default text is one install-wide setting (general_whatsapp_invite_template,
 * written through the generic general-settings writer); without one, or for a
 * role that cannot read settings, the translated default applies.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { MessageCircle } from 'lucide-react';
import type { Event } from '../../../types';
import { Button, Input, Modal, Notice } from '../../../components/common';
import { settingsService } from '../../../services/settings.service';
import { usePermission } from '../../../hooks/usePermission';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';
import { buildWhatsAppUrl, fillInviteTemplate, normalizeWhatsAppPhone } from '../../../utils/whatsappLink';
import { inputClass, labelClass } from './settings/sections';

export const WHATSAPP_TEMPLATE_KEY = 'general_whatsapp_invite_template';

// The translations show the placeholders themselves: each one interpolates
// to its own name, so i18next leaves `{{name}}` in the text.
const KEEP_PLACEHOLDERS = { name: '{{name}}', event: '{{event}}', link: '{{link}}', date: '{{date}}' };

interface WhatsAppInviteDialogProps {
  open: boolean;
  onClose: () => void;
  event: Event;
  /** The full link the message carries. */
  link: string;
  /** The link alone does not open the gallery: say the password goes separately. */
  passwordProtected?: boolean;
}

export const WhatsAppInviteDialog: React.FC<WhatsAppInviteDialogProps> = ({ open, onClose, event, link, passwordProtected = false }) => {
  const { t } = useTranslation();
  const { format } = useLocalizedDate();
  const queryClient = useQueryClient();
  const canReadSettings = usePermission('settings.view');
  const canEditSettings = usePermission('settings.edit');

  const builtInTemplate = t('events.whatsappInvite.defaultTemplate', 'Hello {{name}}, your gallery "{{event}}" is online: {{link}}', KEEP_PLACEHOLDERS);
  const { data: savedTemplate, isLoading: templateLoading } = useQuery({
    queryKey: ['admin-settings', 'whatsapp-invite-template'],
    queryFn: async () => {
      const settings = await settingsService.getSettings([WHATSAPP_TEMPLATE_KEY]);
      const value = settings[WHATSAPP_TEMPLATE_KEY];
      return typeof value === 'string' ? value : '';
    },
    enabled: open && canReadSettings,
  });
  const template = savedTemplate?.trim() ? savedTemplate : builtInTemplate;

  const [phone, setPhone] = useState(event.customer_phone || '');
  const [message, setMessage] = useState('');
  const [editingTemplate, setEditingTemplate] = useState(false);
  const [templateDraft, setTemplateDraft] = useState('');

  const fill = (source: string) => fillInviteTemplate(source, {
    name: event.customer_name,
    event: event.event_name,
    link,
    date: event.event_date ? format(event.event_date) : '',
  });

  // The text waits for the saved default when there is one to read.
  useEffect(() => {
    if (open && !templateLoading) setMessage(fill(template));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, templateLoading, template, link]);

  const saveTemplate = useMutation({
    mutationFn: (value: string) => settingsService.updateSettings({ [WHATSAPP_TEMPLATE_KEY]: value }),
    onSuccess: (_data, value) => {
      queryClient.setQueryData(['admin-settings', 'whatsapp-invite-template'], value);
      setEditingTemplate(false);
      toast.success(t('events.whatsappInvite.templateSaved', 'Default WhatsApp text saved.'));
    },
    onError: () => toast.error(t('events.whatsappInvite.templateSaveFailed', 'The default text could not be saved.')),
  });

  const normalized = normalizeWhatsAppPhone(phone);
  const send = () => {
    window.open(buildWhatsAppUrl(normalized.digits, message), '_blank', 'noopener');
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={() => { if (!saveTemplate.isPending) onClose(); }}
      size="md"
      title={(
        <span className="flex items-center gap-2">
          <MessageCircle className="w-5 h-5 text-accent" />
          {t('events.whatsappInvite.title', 'Send via WhatsApp')}
        </span>
      )}
      description={t('events.whatsappInvite.description', 'Opens WhatsApp with this text. You send it from your own account.')}
      footer={(
        <>
          <Button variant="outline" onClick={onClose} disabled={saveTemplate.isPending}>{t('common.cancel', 'Cancel')}</Button>
          <Button
            variant="primary"
            leftIcon={<MessageCircle className="w-4 h-4" />}
            onClick={send}
            disabled={!message.trim() || saveTemplate.isPending}
          >
            {t('events.whatsappInvite.open', 'Open WhatsApp')}
          </Button>
        </>
      )}
    >
      <div className="space-y-4">
        <Input
          id="whatsapp-invite-phone"
          type="tel"
          label={t('events.whatsappInvite.phoneLabel', 'Phone number')}
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+49 170 1234567"
          error={normalized.status === 'national' || normalized.status === 'invalid'
            ? (normalized.status === 'national'
              ? t('events.whatsappInvite.phoneNational', 'Enter the number in international format, e.g. +49 170 1234567. Without it, WhatsApp asks you to pick the chat.')
              : t('events.whatsappInvite.phoneInvalid', 'This does not look like a phone number. Without it, WhatsApp asks you to pick the chat.'))
            : undefined}
          helperText={normalized.status === 'empty'
            ? t('events.whatsappInvite.phoneEmpty', 'No number: WhatsApp asks you to pick the chat.')
            : undefined}
        />

        <div>
          <label className={labelClass} htmlFor="whatsapp-invite-message">{t('events.whatsappInvite.messageLabel', 'Message')}</label>
          <textarea
            id="whatsapp-invite-message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            className={inputClass}
            rows={5}
          />
          {canEditSettings && !editingTemplate && (
            <Button
              variant="ghost"
              size="sm"
              className="mt-1 text-xs"
              onClick={() => { setTemplateDraft(template); setEditingTemplate(true); }}
            >
              {t('events.whatsappInvite.editTemplate', 'Change the default text')}
            </Button>
          )}
        </div>

        {editingTemplate && (
          <div className="rounded-lg border border-line bg-subtle p-3 space-y-2">
            <label className={labelClass} htmlFor="whatsapp-invite-template">{t('events.whatsappInvite.templateLabel', 'Default text for every gallery')}</label>
            <textarea
              id="whatsapp-invite-template"
              value={templateDraft}
              onChange={(e) => setTemplateDraft(e.target.value)}
              className={inputClass}
              rows={4}
            />
            <p className="text-xs text-muted">
              {t('events.whatsappInvite.templateHelp', 'Placeholders: {{name}} customer name, {{event}} gallery name, {{link}} link, {{date}} event date. Leave empty to use the built-in text.', KEEP_PLACEHOLDERS)}
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setEditingTemplate(false)} disabled={saveTemplate.isPending}>
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button variant="primary" size="sm" isLoading={saveTemplate.isPending} onClick={() => saveTemplate.mutate(templateDraft)}>
                {t('events.whatsappInvite.saveTemplate', 'Save default text')}
              </Button>
            </div>
          </div>
        )}

        {passwordProtected && (
          <Notice tone="info" size="sm">
            {t('events.whatsappInvite.passwordNote', 'This gallery is password-protected. The message does not contain the password: send it separately.')}
          </Notice>
        )}
      </div>
    </Modal>
  );
};
