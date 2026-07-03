import React, { useState } from 'react';
import {
  Mail,
  Save,
  Send,
  Server,
  Lock,
  User,
  AlertCircle,
  CheckCircle,
  Eye,
  EyeOff,
  ShieldAlert,
  Copy,
} from 'lucide-react';
import { toast } from 'react-toastify';

import { Button, Input, Card, Loading } from '../../components/common';
import { EmailPreviewModal } from '../../components/admin/EmailPreviewModal';
import { EmailTemplateEditor } from '../../components/admin/EmailTemplateEditor';
import { SentEmailsPanel } from '../../components/admin/SentEmailsPanel';
import { ReceivedEmailsPanel } from '../../components/admin/ReceivedEmailsPanel';
import { IncomingMailConfigCard } from '../../components/admin/IncomingMailConfigCard';
import { Palette, RefreshCw, Info } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { emailService, type EmailConfig, type EmailTemplate, type EmailTemplateTranslation } from '../../services/email.service';
import { settingsService } from '../../services/settings.service';
import { useTranslation } from 'react-i18next';
import { SUPPORTED_LANGUAGES } from "../../components/common/LanguageSelector.tsx";
import { useFeatureFlags, type FeatureKey } from '../../contexts/FeatureFlagsContext';

/**
 * Template categorisation (migration 098). Sidebar sections render
 * in this order. Empty categories are hidden automatically. New
 * categories: add the key here, give it an i18n label
 * (email.categories.<key>), set `feature_flag` on templates that
 * should chip out when the matching flag is off. No other UI
 * changes required.
 */
const CATEGORY_ORDER: readonly string[] = [
  'core',
  'customers',
  'calendar',
  'quotes',
  // 'contracts' sits between quotes and billing — matches the
  // quote → contract → invoice document flow + the order of the
  // Admin → Clients sub-nav so admins find the right bucket at a
  // glance. Migration 130 seeds rows with category='contracts';
  // before this entry existed they fell through to 'core' via the
  // unknown-category fallback below.
  'contracts',
  'billing',
] as const;

/**
 * Sub-categorisation inside `core` (which carries 14 templates and
 * deserves its own internal headers). Order is the render sequence.
 * Templates whose subcategory isn't in this list fall through to a
 * trailing "other" bucket so a forward-compat row never disappears.
 * Other top-level categories are flat (no sub-sections) for now.
 */
const CORE_SUBCATEGORY_ORDER: readonly string[] = [
  'gallery',
  'admin',
  'backup',
  'system',
] as const;

const defaultTemplateKeys = [
  {
    key: 'gallery_created',
    name: 'Gallery Created',
    subject: 'Your {{event_name}} photos are ready!',
    body: `Hi there!

Your photo gallery for {{event_name}} is now ready to view.

Event: {{event_name}}
Date: {{event_date}}
Password: {{password}}

You can access your photos here: {{gallery_link}}

Your gallery will be available until {{expiration_date}}. Make sure to download your photos before they expire!

{{#if welcome_message}}
Personal message from your host:
{{welcome_message}}
{{/if}}

Best regards,
The Photo Sharing Team`,
    variables: ['event_name', 'event_date', 'password', 'gallery_link', 'expiration_date', 'welcome_message']
  },
  {
    key: 'expiration_warning',
    name: 'Expiration Warning',
    subject: 'Your {{event_name}} photos expire in {{days_remaining}} days!',
    body: `Important: Your photo gallery is expiring soon!

Your photos from {{event_name}} will no longer be available after {{expiration_date}}.

You have {{days_remaining}} days remaining to download your photos.

Access your gallery here: {{gallery_link}}

Don't forget to download all your favorite memories before they're gone!

Best regards,
The Photo Sharing Team`,
    variables: ['event_name', 'days_remaining', 'expiration_date', 'gallery_link']
  },
  {
    key: 'gallery_expired',
    name: 'Gallery Expired',
    subject: 'Your {{event_name}} photo gallery has expired',
    body: `Your photo gallery for {{event_name}} has expired and is no longer accessible.

The photos have been archived for safekeeping. If you need access to them, please contact the event administrator at {{admin_email}}.

Thank you for using our photo sharing service!

Best regards,
The Photo Sharing Team`,
    variables: ['event_name', 'admin_email']
  },
  {
    key: 'archive_complete',
    name: 'Archive Complete (Admin)',
  }
];

export const EmailConfigPage: React.FC = () => {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<'smtp' | 'templates' | 'sent' | 'received'>('smtp');
  const [selectedTemplateKey, setSelectedTemplateKey] = useState<string>('gallery_created');
  const [editedTemplate, setEditedTemplate] = useState<Partial<EmailTemplate>>({});
  const [editingLang, setEditingLang] = useState<string>('en');
  const [showPassword, setShowPassword] = useState(false);
  const [testEmail, setTestEmail] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const [previewData, setPreviewData] = useState<{ subject: string; htmlContent: string; textContent?: string }>({
    subject: '',
    htmlContent: '',
    textContent: ''
  });
  // 8-token email palette. The first two are the historical settings —
  // upgraded installs keep their saved values. The last six are new and
  // default to the literals previously hard-coded into emailProcessor.js,
  // which means an admin who never opens this card sees emails render
  // exactly as before. Touching any picker enables full email theming.
  const [emailPrimaryColor, setEmailPrimaryColor] = useState('#5C8762');
  const [emailSecondaryColor, setEmailSecondaryColor] = useState('#f9f9f9');
  const [emailBodyBgColor, setEmailBodyBgColor] = useState('#f5f5f5');
  const [emailContainerBgColor, setEmailContainerBgColor] = useState('#ffffff');
  const [emailListBgColor, setEmailListBgColor] = useState('#f9f9f9');
  const [emailBodyTextColor, setEmailBodyTextColor] = useState('#333333');
  const [emailMutedTextColor, setEmailMutedTextColor] = useState('#666666');
  const [emailButtonTextColor, setEmailButtonTextColor] = useState('#ffffff');
  const queryClient = useQueryClient();
  const { flags: featureFlags } = useFeatureFlags();

  // SMTP Configuration state
  const [smtpConfig, setSmtpConfig] = useState<EmailConfig>({
    smtp_host: '',
    smtp_port: 587,
    smtp_secure: false,
    smtp_user: '',
    smtp_pass: '',
    from_email: '',
    from_name: 'Photo Sharing',
    tls_reject_unauthorized: true
  });

  // Fetch SMTP config
  const { isLoading: configLoading } = useQuery({
    queryKey: ['email-config'],
    queryFn: () => emailService.getConfig(),
  });

  // Fetch email branding colors from app settings
  const { data: allSettings } = useQuery({
    queryKey: ['admin-settings'],
    queryFn: () => settingsService.getAllSettings(),
  });

  React.useEffect(() => {
    if (allSettings) {
      if (allSettings.email_primary_color) setEmailPrimaryColor(allSettings.email_primary_color);
      if (allSettings.email_secondary_color) setEmailSecondaryColor(allSettings.email_secondary_color);
      if (allSettings.email_body_bg_color) setEmailBodyBgColor(allSettings.email_body_bg_color);
      if (allSettings.email_container_bg_color) setEmailContainerBgColor(allSettings.email_container_bg_color);
      if (allSettings.email_list_bg_color) setEmailListBgColor(allSettings.email_list_bg_color);
      if (allSettings.email_body_text_color) setEmailBodyTextColor(allSettings.email_body_text_color);
      if (allSettings.email_muted_text_color) setEmailMutedTextColor(allSettings.email_muted_text_color);
      if (allSettings.email_button_text_color) setEmailButtonTextColor(allSettings.email_button_text_color);
    }
  }, [allSettings]);

  // Fetch email templates
  const { data: templates = [], isLoading: templatesLoading } = useQuery({
    queryKey: ['email-templates'],
    queryFn: () => emailService.getTemplates()
  });

  // Fetch selected template details
  const { data: selectedTemplate } = useQuery({
    queryKey: ['email-template', selectedTemplateKey],
    queryFn: () => emailService.getTemplate(selectedTemplateKey),
    enabled: !!selectedTemplateKey && activeTab === 'templates',
  });

  // Update local state when data is fetched
  React.useEffect(() => {
    const fetchConfig = async () => {
      try {
        const config = await emailService.getConfig();
        setSmtpConfig(config);
      } catch (error) {
        // Config might not exist yet
      }
    };
    fetchConfig();
  }, []);

  React.useEffect(() => {
    if (selectedTemplate) {
      setEditedTemplate(selectedTemplate);
    }
  }, [selectedTemplate]);

  // Mutations
  // Surface the actual backend error (SMTP auth/connection failure, masked
  // password, private-host rejection, …) instead of a generic toast — for
  // email config these messages are the whole diagnosis.
  const errMsg = (e: any, fallback: string): string =>
    e?.response?.data?.error
    || e?.response?.data?.details
    || e?.message
    || fallback;

  const saveConfigMutation = useMutation({
    mutationFn: (config: EmailConfig) => emailService.updateConfig(config),
    onSuccess: () => {
      toast.success(t('toast.emailConfigSaved'));
      queryClient.invalidateQueries({ queryKey: ['email-config'] });
    },
    onError: (e: any) => {
      toast.error(errMsg(e, t('toast.saveError')));
    }
  });

  const testEmailMutation = useMutation({
    mutationFn: (email: string) => emailService.testEmail(email),
    onSuccess: () => {
      toast.success(t('email.testEmailSuccess'));
    },
    onError: (e: any) => {
      toast.error(errMsg(e, t('toast.saveError')));
    }
  });

  const flushQueueMutation = useMutation({
    mutationFn: () => emailService.flushQueue(),
    onSuccess: (summary) => {
      if (summary.processed === 0) {
        toast.info(t('email.flushQueue.empty'));
      } else {
        toast.success(t('email.flushQueue.success', { sent: summary.sent, failed: summary.failed }));
      }
    },
    onError: (e: any) => {
      toast.error(errMsg(e, t('toast.saveError')));
    }
  });

  const saveTemplateMutation = useMutation({
    mutationFn: ({ key, translations }: { key: string; translations: Record<string, EmailTemplateTranslation> }) =>
      emailService.updateTemplate(key, { translations }),
    onSuccess: () => {
      toast.success(t('toast.saveSuccess'));
      queryClient.invalidateQueries({ queryKey: ['email-templates'] });
      queryClient.invalidateQueries({ queryKey: ['email-template', selectedTemplateKey] });
    },
    onError: () => {
      toast.error(t('toast.saveError'));
    }
  });

  const saveEmailColorsMutation = useMutation({
    mutationFn: (colors: Record<string, string>) =>
      settingsService.updateSettings(colors),
    onSuccess: () => {
      toast.success(t('toast.saveSuccess'));
      queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
    },
    onError: () => {
      toast.error(t('toast.saveError'));
    }
  });

  const handleSaveEmailColors = () => {
    saveEmailColorsMutation.mutate({
      email_primary_color: emailPrimaryColor,
      email_secondary_color: emailSecondaryColor,
      email_body_bg_color: emailBodyBgColor,
      email_container_bg_color: emailContainerBgColor,
      email_list_bg_color: emailListBgColor,
      email_body_text_color: emailBodyTextColor,
      email_muted_text_color: emailMutedTextColor,
      email_button_text_color: emailButtonTextColor,
    });
  };

  /**
   * Sync email colours from the active Branding theme so admins can hit one
   * button and have email + site share an identical palette.
   *
   * Mapping (Branding token → email token):
   *   accentDarkColor   → email_primary_color    (header bg, H2, button bg, link)
   *   surfaceColor      → email_secondary_color  (footer bg)
   *   backgroundColor   → email_body_bg_color    (outer wrapper)
   *   surfaceColor      → email_container_bg_color (email card)
   *   elevatedColor     → email_list_bg_color    (info <ul> panel)
   *   textColor         → email_body_text_color
   *   mutedTextColor    → email_muted_text_color
   *   (constant)        → email_button_text_color (#ffffff — no Branding equivalent)
   *
   * Just updates local state — admin still has to click Save to persist.
   * That two-step keeps the flow predictable and avoids surprise saves.
   */
  const handleSyncFromBranding = () => {
    const theme = allSettings?.theme_config || {};
    const accentDark = theme.accentDarkColor || theme.primaryColor || '#5C8762';
    const surface = theme.surfaceColor || '#ffffff';
    const background = theme.backgroundColor || '#fafafa';
    const elevated = theme.elevatedColor || '#f5f5f5';
    const textColor = theme.textColor || '#171717';
    const mutedText = theme.mutedTextColor || '#737373';

    setEmailPrimaryColor(accentDark);
    setEmailSecondaryColor(surface);
    setEmailBodyBgColor(background);
    setEmailContainerBgColor(surface);
    setEmailListBgColor(elevated);
    setEmailBodyTextColor(textColor);
    setEmailMutedTextColor(mutedText);
    // Button text stays #ffffff — needs to read on accent-dark fill regardless
    // of branding accent choice. Admins can still override it manually.
    toast.info(t('email.syncedFromBranding', 'Email colours synced from Branding. Click Save to apply.'));
  };

  const handleSaveSmtp = () => {
    // Validate SMTP config
    if (!smtpConfig.smtp_host || !smtpConfig.smtp_port || !smtpConfig.from_email) {
      toast.error(t('errors.requiredFields'));
      return;
    }

    saveConfigMutation.mutate(smtpConfig);
  };

  const handleTestEmail = () => {
    if (!testEmail) {
      toast.error(t('errors.enterTestEmail'));
      return;
    }

    testEmailMutation.mutate(testEmail);
  };

  // Get current translation for the editing language
  const currentTranslation = editedTemplate.translations?.[editingLang] || { subject: '', body_html: '', body_text: '' };

  const handleTranslationChange = (field: keyof EmailTemplateTranslation, value: string) => {
    setEditedTemplate(prev => ({
      ...prev,
      translations: {
        ...prev.translations,
        [editingLang]: {
          ...prev.translations?.[editingLang],
          [field]: value,
        },
      },
    }));
  };

  const handleCopyFromLanguage = (sourceLang: string) => {
    const sourceTranslation = editedTemplate.translations?.[sourceLang];
    if (!sourceTranslation) return;

    setEditedTemplate(prev => ({
      ...prev,
      translations: {
        ...prev.translations,
        [editingLang]: { ...sourceTranslation },
      },
    }));
    toast.info(t('email.copiedFromLanguage', { language: SUPPORTED_LANGUAGES.find(l => l.code === sourceLang)?.name || sourceLang }));
  };

  const handleSaveTemplate = () => {
    if (selectedTemplateKey && editedTemplate.translations) {
      saveTemplateMutation.mutate({
        key: selectedTemplateKey,
        translations: editedTemplate.translations,
      });
    }
  };

  const handlePreviewTemplate = async () => {
    if (!selectedTemplateKey || !editedTemplate) return;

    // Generate sample data based on the template
    const sampleData: Record<string, string> = {
      event_name: 'John & Jane Wedding',
      event_date: 'December 25, 2024',
      password: '••••••••',
      gallery_link: 'https://photos.example.com/gallery/john-jane-wedding',
      expiration_date: 'January 25, 2025',
      welcome_message: 'Thank you for celebrating our special day with us!',
      days_remaining: '30',
      admin_email: 'admin@example.com',
      host_email: 'host@example.com'
    };

    try {
      const preview = await emailService.previewTemplate(selectedTemplateKey, sampleData, editingLang);
      setPreviewData({
        subject: preview.subject,
        htmlContent: preview.body_html,
        textContent: preview.body_text
      });
      setShowPreview(true);
    } catch (error) {
      toast.error(t('toast.saveError'));
    }
  };

  // Count how many languages have translations for a template
  const getTranslationCount = (template: EmailTemplate) => {
    if (!template.translations) return 0;
    return Object.keys(template.translations).filter(
      lang => template.translations[lang]?.subject || template.translations[lang]?.body_html
    ).length;
  };

  // Languages that have content and can be copied from
  const copySourceLanguages = SUPPORTED_LANGUAGES.filter(
    lang => lang.code !== editingLang && editedTemplate.translations?.[lang.code]?.body_html
  );

  if (configLoading || templatesLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loading size="lg" text={t('email.loadingSettings')} />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">{t('email.title')}</h1>
        <p className="text-neutral-600 dark:text-neutral-400 mt-1">{t('email.subtitle')}</p>
      </div>

      {/* Tab Navigation */}
      <div className="border-b border-neutral-200 dark:border-neutral-700 mb-6">
        <nav className="-mb-px flex gap-6">
          <button
            onClick={() => setActiveTab('smtp')}
            className={`py-2 px-1 border-b-2 font-medium text-sm transition-colors ${
              activeTab === 'smtp'
                ? 'border-accent text-accent'
                : 'border-transparent text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300'
            }`}
          >
            {t('email.smtpSettings')}
          </button>
          <button
            onClick={() => setActiveTab('templates')}
            className={`py-2 px-1 border-b-2 font-medium text-sm transition-colors ${
              activeTab === 'templates'
                ? 'border-accent text-accent'
                : 'border-transparent text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300'
            }`}
          >
            {t('email.emailTemplates')}
          </button>
          <button
            onClick={() => setActiveTab('sent')}
            className={`py-2 px-1 border-b-2 font-medium text-sm transition-colors ${
              activeTab === 'sent'
                ? 'border-accent text-accent'
                : 'border-transparent text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300'
            }`}
          >
            {t('email.sentEmails.tab', 'Sent emails')}
          </button>
          {featureFlags.incomingMail && (
            <button
              onClick={() => setActiveTab('received')}
              className={`py-2 px-1 border-b-2 font-medium text-sm transition-colors ${
                activeTab === 'received'
                  ? 'border-accent text-accent'
                  : 'border-transparent text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300'
              }`}
            >
              {t('email.received.tab', 'Received emails')}
            </button>
          )}
        </nav>
      </div>

      {/* Sent emails Tab */}
      {activeTab === 'sent' && <SentEmailsPanel />}

      {/* Received emails Tab */}
      {activeTab === 'received' && <ReceivedEmailsPanel />}

      {/* SMTP Settings Tab */}
      {activeTab === 'smtp' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card padding="md">
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">{t('email.smtpConfiguration')}</h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                  {t('email.smtpHost')} <span className="text-red-500">*</span>
                </label>
                <Input
                  type="text"
                  value={smtpConfig.smtp_host}
                  onChange={(e) => setSmtpConfig(prev => ({ ...prev, smtp_host: e.target.value }))}
                  placeholder="smtp.gmail.com"
                  leftIcon={<Server className="w-5 h-5 text-neutral-400" />}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                    {t('email.port')} <span className="text-red-500">*</span>
                  </label>
                  <Input
                    type="number"
                    value={smtpConfig.smtp_port}
                    onChange={(e) => setSmtpConfig(prev => ({ ...prev, smtp_port: parseInt(e.target.value) || 587 }))}
                    placeholder="587"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                    {t('email.security')}
                  </label>
                  <select
                    value={smtpConfig.smtp_secure ? 'ssl' : 'tls'}
                    onChange={(e) => setSmtpConfig(prev => ({ ...prev, smtp_secure: e.target.value === 'ssl' }))}
                    className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-accent-dark"
                  >
                    <option value="tls">TLS</option>
                    <option value="ssl">SSL</option>
                  </select>
                </div>
              </div>

              {/* Ignore SSL Certificate Errors */}
              <div className="mt-2">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!smtpConfig.tls_reject_unauthorized}
                    onChange={(e) => setSmtpConfig(prev => ({ ...prev, tls_reject_unauthorized: !e.target.checked }))}
                    className="w-4 h-4 text-accent border-neutral-300 dark:border-neutral-600 rounded focus:ring-primary-500"
                  />
                  <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                    {t('email.ignoreSslErrors')}
                  </span>
                </label>
                {!smtpConfig.tls_reject_unauthorized && (
                  <div className="mt-2 p-3 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-lg">
                    <div className="flex items-start gap-2">
                      <ShieldAlert className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                      <p className="text-xs text-amber-800 dark:text-amber-300">
                        {t('email.ignoreSslWarning')}
                      </p>
                    </div>
                  </div>
                )}</div>

              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                  {t('email.username')}
                </label>
                <Input
                  type="text"
                  value={smtpConfig.smtp_user}
                  onChange={(e) => setSmtpConfig(prev => ({ ...prev, smtp_user: e.target.value }))}
                  placeholder="your-email@gmail.com"
                  leftIcon={<User className="w-5 h-5 text-neutral-400" />}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                  {t('email.password')}
                </label>
                <div className="relative">
                  <Input
                    type={showPassword ? 'text' : 'password'}
                    value={smtpConfig.smtp_pass}
                    onChange={(e) => setSmtpConfig(prev => ({ ...prev, smtp_pass: e.target.value }))}
                    placeholder={t('email.enterPassword')}
                    leftIcon={<Lock className="w-5 h-5 text-neutral-400" />}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-3 text-neutral-400 hover:text-neutral-600"
                  >
                    {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                  {t('email.fromEmail')} <span className="text-red-500">*</span>
                </label>
                <Input
                  type="email"
                  value={smtpConfig.from_email}
                  onChange={(e) => setSmtpConfig(prev => ({ ...prev, from_email: e.target.value }))}
                  placeholder="noreply@yourdomain.com"
                  leftIcon={<Mail className="w-5 h-5 text-neutral-400" />}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                  {t('email.fromName')}
                </label>
                <Input
                  type="text"
                  value={smtpConfig.from_name}
                  onChange={(e) => setSmtpConfig(prev => ({ ...prev, from_name: e.target.value }))}
                  placeholder="Photo Sharing"
                />
              </div>

              <Button
                variant="primary"
                onClick={handleSaveSmtp}
                isLoading={saveConfigMutation.isPending}
                leftIcon={<Save className="w-5 h-5" />}
                className="w-full"
              >
                {t('email.saveSmtpSettings')}
              </Button>
            </div>
          </Card>

          <Card padding="md">
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">{t('email.testEmailSection')}</h2>

            <div className="mb-4 p-4 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-lg">
              <div className="flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
                <div className="text-sm text-amber-800 dark:text-amber-300">
                  <p className="font-medium">{t('email.beforeTesting')}</p>
                  <ul className="list-disc list-inside mt-1">
                    <li>{t('email.saveSmtpFirst')}</li>
                    <li>{t('email.ensureFirewall')}</li>
                    <li>{t('email.gmailAppPassword')}</li>
                  </ul>
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                  {t('email.testEmailAddressLabel')}
                </label>
                <Input
                  type="email"
                  value={testEmail}
                  onChange={(e) => setTestEmail(e.target.value)}
                  placeholder="test@example.com"
                  leftIcon={<Mail className="w-5 h-5 text-neutral-400" />}
                />
              </div>

              <Button
                variant="outline"
                onClick={handleTestEmail}
                isLoading={testEmailMutation.isPending}
                leftIcon={<Send className="w-5 h-5" />}
                className="w-full"
              >
                {t('email.sendTestEmailButton')}
              </Button>
            </div>

            <div className="mt-6 p-4 bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800 rounded-lg">
              <div className="flex items-start gap-3">
                <CheckCircle className="w-5 h-5 text-green-600 dark:text-green-400 flex-shrink-0" />
                <div className="text-sm text-green-800 dark:text-green-300">
                  <p className="font-medium">{t('email.commonSmtpSettings')}</p>
                  <ul className="mt-2 space-y-1">
                    <li><strong>Gmail:</strong> smtp.gmail.com:587 (TLS)</li>
                    <li><strong>Outlook:</strong> smtp-mail.outlook.com:587 (TLS)</li>
                    <li><strong>SendGrid:</strong> smtp.sendgrid.net:587 (TLS)</li>
                  </ul>
                </div>
              </div>
            </div>
          </Card>

          <Card padding="md">
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-2">{t('email.flushQueue.title')}</h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">{t('email.flushQueue.help')}</p>
            <Button
              variant="outline"
              onClick={() => flushQueueMutation.mutate()}
              isLoading={flushQueueMutation.isPending}
              leftIcon={<Send className="w-5 h-5" />}
              className="w-full"
            >
              {t('email.flushQueue.button')}
            </Button>
          </Card>
        </div>
      )}

      {/* Email Branding - below SMTP settings */}
      {activeTab === 'smtp' && (
        <div className="mt-6">
          <Card padding="md">
            <div className="flex items-center justify-between gap-4 mb-4">
              <div className="flex items-center gap-2">
                <Palette className="w-5 h-5 text-neutral-500" />
                <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">{t('email.brandingTitle')}</h2>
              </div>
              {/* One-click copy from Branding theme so email + site share an
                  identical palette. Just stages the values — admin still has
                  to click Save to persist (avoids surprise mass-saves). */}
              <Button
                variant="outline"
                size="sm"
                onClick={handleSyncFromBranding}
                leftIcon={<RefreshCw className="w-4 h-4" />}
              >
                {t('email.syncFromBranding', 'Sync from Branding')}
              </Button>
            </div>
            <p className="text-sm text-neutral-500 dark:text-neutral-400 mb-6">{t('email.brandingDescription')}</p>

            {/* 8 email colour pickers. Each row uses the same compact label
                + info-tooltip pattern as the gallery palette in
                ThemeCustomizerEnhanced — keeps the two configurators visually
                consistent without sharing the React component (the email
                state is local to this page and saved through a different
                endpoint, so reuse would be more friction than value). */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
              {[
                { label: t('email.primaryColor', 'Primary'), help: t('email.primaryColorHelp', 'Header bar, H2 headings, button background, link colour. Maps to Branding → Accent (filled).'), value: emailPrimaryColor, setter: setEmailPrimaryColor, fallback: '#5C8762' },
                { label: t('email.secondaryColor', 'Footer background'), help: t('email.secondaryColorHelp', 'Footer bar background. Maps to Branding → Surface.'), value: emailSecondaryColor, setter: setEmailSecondaryColor, fallback: '#f9f9f9' },
                { label: t('email.bodyBgColor', 'Page background'), help: t('email.bodyBgColorHelp', 'The wrapper around the email card — what the recipient sees behind the email itself. Maps to Branding → Background.'), value: emailBodyBgColor, setter: setEmailBodyBgColor, fallback: '#f5f5f5' },
                { label: t('email.containerBgColor', 'Email card'), help: t('email.containerBgColorHelp', 'The white card that holds the email content. Maps to Branding → Surface.'), value: emailContainerBgColor, setter: setEmailContainerBgColor, fallback: '#ffffff' },
                { label: t('email.listBgColor', 'Info panel'), help: t('email.listBgColorHelp', 'Background of the bulleted info panels inside the email body. Maps to Branding → Elevated.'), value: emailListBgColor, setter: setEmailListBgColor, fallback: '#f9f9f9' },
                { label: t('email.bodyTextColor', 'Body text'), help: t('email.bodyTextColorHelp', 'Paragraph and bold text colour. Maps to Branding → Primary text.'), value: emailBodyTextColor, setter: setEmailBodyTextColor, fallback: '#333333' },
                { label: t('email.mutedTextColor', 'Footer text'), help: t('email.mutedTextColorHelp', 'Footer text and copyright line. Maps to Branding → Secondary text.'), value: emailMutedTextColor, setter: setEmailMutedTextColor, fallback: '#666666' },
                { label: t('email.buttonTextColor', 'Button text'), help: t('email.buttonTextColorHelp', 'Text colour on filled buttons. Should contrast cleanly against the Primary colour. No Branding equivalent — usually white.'), value: emailButtonTextColor, setter: setEmailButtonTextColor, fallback: '#ffffff' },
              ].map(({ label, help, value, setter, fallback }) => (
                <div key={label}>
                  <label className="flex items-center gap-1.5 text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                    {label}
                    <span className="info-tooltip text-neutral-400 dark:text-neutral-500" data-tooltip={help} tabIndex={0}>
                      <Info className="w-3.5 h-3.5" />
                    </span>
                  </label>
                  <div className="flex items-center gap-3">
                    <input
                      type="color"
                      value={value}
                      onChange={(e) => setter(e.target.value)}
                      className="w-10 h-10 rounded border border-neutral-300 dark:border-neutral-600 cursor-pointer"
                    />
                    <Input
                      type="text"
                      value={value}
                      onChange={(e) => setter(e.target.value)}
                      className="w-32"
                      placeholder={fallback}
                    />
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-6">
              <Button
                variant="primary"
                onClick={handleSaveEmailColors}
                isLoading={saveEmailColorsMutation.isPending}
                leftIcon={<Save className="w-5 h-5" />}
              >
                {t('email.saveEmailColors')}
              </Button>
            </div>
          </Card>
        </div>
      )}

      {/* Email Templates Tab */}
      {/* Incoming mail (IMAP) — a second block under SMTP, flag-gated. */}
      {activeTab === 'smtp' && featureFlags.incomingMail && <IncomingMailConfigCard />}

      {activeTab === 'templates' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Card padding="sm">
            <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">{t('email.templates')}</h3>
            {/* Templates grouped by category (migration 098). Categories
                in CATEGORY_ORDER render in sequence; templates that
                report an unrecognised category fall into 'core' so a
                forward-compat row never disappears from the UI.
                Empty categories are hidden — admins don't see a
                section header with no body. Templates whose
                feature_flag is currently false stay fully visible and
                editable, just chip-tagged so the admin knows the
                feature is dormant. */}
            {(() => {
              // 1. Bucket templates by top-level category (forward-compat:
              //    unknown categories fall into 'core').
              const byCategory: Record<string, EmailTemplate[]> = {};
              for (const template of templates) {
                const cat = CATEGORY_ORDER.includes(template.category || 'core')
                  ? (template.category || 'core')
                  : 'core';
                (byCategory[cat] = byCategory[cat] || []).push(template);
              }
              const visibleCategories = CATEGORY_ORDER.filter((c) => byCategory[c]?.length);

              // 2. Renders a single template button. Pulled out so the
              //    flat path and the sub-category path share it.
              const renderTemplate = (template: EmailTemplate) => {
                const templateInfo = defaultTemplateKeys.find((t) => t.key === template.template_key);
                const translationCount = getTranslationCount(template);
                const enTranslation = template.translations?.en;
                const featureOff = template.feature_flag
                  ? featureFlags[template.feature_flag as FeatureKey] === false
                  : false;
                return (
                  <button
                    key={template.template_key}
                    onClick={() => {
                      setSelectedTemplateKey(template.template_key);
                      setEditedTemplate(template);
                    }}
                    className={`w-full text-left p-3 rounded-lg transition-colors ${
                      selectedTemplateKey === template.template_key
                        ? 'tile-selected'
                        : 'bg-neutral-50 dark:bg-neutral-700 border-2 border-transparent hover:bg-neutral-100 dark:hover:bg-neutral-600'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-medium text-neutral-900 dark:text-neutral-100 truncate">
                        {templateInfo?.name || template.template_key}
                      </p>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        {featureOff && (
                          <span
                            className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-semibold bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
                            title={t('email.featureOffTooltip', 'The feature this template belongs to is currently disabled. You can still edit the template — it will be used once the feature is re-enabled.')}
                          >
                            {t('email.featureOff', 'Feature off')}
                          </span>
                        )}
                        <span className="text-xs px-2 py-0.5 rounded-full bg-neutral-200 dark:bg-neutral-600 text-neutral-600 dark:text-neutral-300">
                          {translationCount}/{SUPPORTED_LANGUAGES.length}
                        </span>
                      </div>
                    </div>
                    <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1 truncate">
                      {enTranslation?.subject || ''}
                    </p>
                  </button>
                );
              };

              return (
                <div className="space-y-5">
                  {visibleCategories.map((category) => {
                    // Inside 'core' we group templates further by
                    // subcategory so the busy bucket reads cleanly.
                    // Other categories render their templates flat.
                    if (category === 'core') {
                      const bySub: Record<string, EmailTemplate[]> = {};
                      for (const template of byCategory.core) {
                        const sub = CORE_SUBCATEGORY_ORDER.includes(template.subcategory || '')
                          ? (template.subcategory as string)
                          : 'other';
                        (bySub[sub] = bySub[sub] || []).push(template);
                      }
                      const visibleSubs = [
                        ...CORE_SUBCATEGORY_ORDER.filter((s) => bySub[s]?.length),
                        ...(bySub.other?.length ? ['other'] : []),
                      ];
                      return (
                        <div key={category}>
                          <h4 className="px-1 mb-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                            {t(`email.categories.${category}`, category)}
                          </h4>
                          <div className="space-y-4 pl-1">
                            {visibleSubs.map((sub) => (
                              <div key={sub}>
                                <h5 className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
                                  {t(`email.subcategories.${sub}`, sub)}
                                </h5>
                                <div className="space-y-2">
                                  {bySub[sub].map(renderTemplate)}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    }
                    return (
                      <div key={category}>
                        <h4 className="px-1 mb-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                          {t(`email.categories.${category}`, category)}
                        </h4>
                        <div className="space-y-2">
                          {byCategory[category].map(renderTemplate)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </Card>

          <div className="lg:col-span-2">
            <Card padding="md">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">{t('email.editTemplate')}</h3>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handlePreviewTemplate}
                    leftIcon={<Eye className="w-4 h-4" />}
                  >
                    {t('email.preview')}
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handleSaveTemplate}
                    isLoading={saveTemplateMutation.isPending}
                    leftIcon={<Save className="w-4 h-4" />}
                  >
                    {t('email.save')}
                  </Button>
                </div>
              </div>

              {/* Language tabs */}
              <div className="flex flex-wrap gap-1 mb-4 p-1 bg-neutral-100 dark:bg-neutral-700 rounded-lg">
                {SUPPORTED_LANGUAGES.map(lang => {
                  const hasContent = editedTemplate.translations?.[lang.code]?.body_html;
                  return (
                    <button
                      key={lang.code}
                      onClick={() => setEditingLang(lang.code)}
                      className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors flex items-center gap-1.5 ${
                        editingLang === lang.code
                          ? 'bg-white dark:bg-neutral-800 text-accent-dark shadow-sm'
                          : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200'
                      }`}
                    >
                      <lang.Flag/>
                      <span>{lang.name}</span>
                      {!hasContent && lang.code !== 'en' && (
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400" title={t('email.noTranslation')} />
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Copy from language */}
              {!currentTranslation.body_html && copySourceLanguages.length > 0 && (
                <div className="mb-4 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
                  <p className="text-sm text-blue-800 dark:text-blue-300 mb-2">{t('email.noTranslationYet')}</p>
                  <div className="flex flex-wrap gap-2">
                    {copySourceLanguages.map(lang => (
                      <button
                        key={lang.code}
                        onClick={() => handleCopyFromLanguage(lang.code)}
                        className="inline-flex items-center gap-1.5 px-3 py-1 text-sm bg-white dark:bg-neutral-800 border border-blue-300 dark:border-blue-700 rounded-md hover:bg-blue-50 dark:hover:bg-blue-900/30 text-blue-700 dark:text-blue-300"
                      >
                        <Copy className="w-3.5 h-3.5" />
                        {t('email.copyFrom')} {lang.flag} {lang.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                    {t('email.templateName')}
                  </label>
                  <Input
                    type="text"
                    value={defaultTemplateKeys.find(t => t.key === selectedTemplateKey)?.name || selectedTemplateKey}
                    disabled
                    className="bg-neutral-50 dark:bg-neutral-700"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                    {t('email.subjectLine')} ({SUPPORTED_LANGUAGES.find(l => l.code === editingLang)?.name || editingLang})
                  </label>
                  <Input
                    type="text"
                    value={currentTranslation.subject || ''}
                    onChange={(e) => handleTranslationChange('subject', e.target.value)}
                    placeholder="Email subject"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                    {t('email.emailBody')} ({SUPPORTED_LANGUAGES.find(l => l.code === editingLang)?.name || editingLang})
                  </label>
                  <EmailTemplateEditor
                    content={currentTranslation.body_html || ''}
                    onChange={(value) => handleTranslationChange('body_html', value)}
                    variables={editedTemplate.variables || []}
                  />
                </div>
              </div>
            </Card>
          </div>
        </div>
      )}

      {/* Email Preview Modal */}
      <EmailPreviewModal
        isOpen={showPreview}
        onClose={() => setShowPreview(false)}
        subject={previewData.subject}
        htmlContent={previewData.htmlContent}
        textContent={previewData.textContent}
      />
    </div>
  );
};
