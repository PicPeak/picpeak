/**
 * Admin → Settings → CRM → Reminder Emails.
 *
 * Two-column layout deliberately mirroring the contract block library
 * and the email-template editor so admins navigate one shape across
 * every template surface. Left rail lists "Default (catch-all)" first,
 * then every active event_type from the catalog with a "Default" pill
 * when no per-type template exists yet (admin's first save creates it
 * from whatever's currently in the form, which on entry mirrors the
 * default).
 *
 * Right panel: full language tab row (EN/DE/RU/PT/NL/FR with flags +
 * amber bullets for missing translations) → Subject input → the same
 * tiptap-based `EmailTemplateEditor` used in the main email-templates
 * editor so the body styling, toolbar, and variable inserter match.
 *
 * Plus a header strip with the two global toggles (`crm_event_reminders_enabled`,
 * `crm_event_reminders_days_before`).
 *
 * Template-key naming convention (matches eventReminderService):
 *   - `event_reminder_default` — catch-all, seeded at runtime
 *   - `event_reminder_<event_type slug_prefix>` — per-type override
 *
 * Per-type templates that don't exist yet have their right-panel fields
 * pre-filled from the default's content so admin can see what the
 * customer would currently receive and decide whether to override.
 * First Save on such a row hits POST /admin/email/templates which
 * creates the per-type row.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Save, AlertTriangle, Workflow as WorkflowIcon } from 'lucide-react';
import { Button, Card, Loading, Input } from '../../../components/common';
import { SUPPORTED_LANGUAGES } from '../../../components/common/LanguageSelector';
import { EmailTemplateEditor } from '../../../components/admin/EmailTemplateEditor';
import { eventTypesService } from '../../../services/eventTypes.service';
import { emailService, type EmailTemplateTranslation } from '../../../services/email.service';
import { settingsService } from '../../../services/settings.service';
import { useFeatureFlags } from '../../../contexts/FeatureFlagsContext';
import { useMutationWithToast } from '../../../hooks';

const TEMPLATE_KEY_DEFAULT = 'event_reminder_default';
const TEMPLATE_KEY_PREFIX = 'event_reminder_';

const VARIABLES = [
  'customer_name', 'event_name', 'event_date',
  'event_type', 'days_before', 'business_name',
];

interface SidebarRow {
  key: string;
  label: string;
  emoji: string;
  isDefault: boolean;
  hasTemplate: boolean;
}

export const ReminderTemplatesPage: React.FC = () => {
  const { t } = useTranslation();

  // Global on/off + lead time: owned by the "Pre-event reminder" workflow when
  // the engine is live; otherwise the legacy crm_event_reminders_* settings drive
  // the hourly pass, so we keep their controls. Per-event override (disable /
  // offset / custom body) always lives on the event detail page.
  const { flags } = useFeatureFlags();
  const workflowsLive = !!flags.workflows;

  const { data: settings } = useQuery({
    queryKey: ['reminder-settings'],
    queryFn: () => settingsService.getSettings([
      'crm_event_reminders_enabled',
      'crm_event_reminders_days_before',
    ]),
    enabled: !workflowsLive,
  });
  const [enabled, setEnabled] = useState<boolean>(false);
  const [daysBefore, setDaysBefore] = useState<number>(2);
  useEffect(() => {
    if (!settings) return;
    const e = settings.crm_event_reminders_enabled;
    setEnabled(e === true || e === 'true' || e === 1 || e === '1');
    const d = Number(settings.crm_event_reminders_days_before);
    setDaysBefore(Number.isFinite(d) ? d : 2);
  }, [settings]);
  const saveSettingsMutation = useMutationWithToast({
    mutationFn: () => settingsService.updateSettings({
      crm_event_reminders_enabled: enabled,
      crm_event_reminders_days_before: daysBefore,
    }),
    successMessage: t('reminderTemplates.settingsSaved', 'Reminder settings saved.'),
    invalidateKeys: [['reminder-settings']],
    errorMessage: () => t('reminderTemplates.settingsSaveError', 'Could not save reminder settings.'),
  });

  // ---- Event types catalog ---------------------------------------------
  const { data: eventTypes = [] } = useQuery({
    queryKey: ['event-types-active'],
    queryFn: () => eventTypesService.getActiveEventTypes(),
  });

  // ---- All templates (for the "has template?" indicator) ---------------
  // GET /templates triggers the runtime self-heal on the backend, which
  // backfills empty/missing event_reminder_* rows with the example
  // content. By the time this list resolves, the default has content.
  const { data: allTemplates = [] } = useQuery({
    queryKey: ['email-templates'],
    queryFn: () => emailService.getTemplates(),
  });
  const reminderTemplateKeys = useMemo(
    () => new Set(allTemplates
      .filter((t) => t.template_key.startsWith(TEMPLATE_KEY_PREFIX))
      .map((t) => t.template_key)),
    [allTemplates],
  );

  // ---- Sidebar rows ------------------------------------------------------
  const sidebarRows: SidebarRow[] = useMemo(() => {
    const rows: SidebarRow[] = [{
      key: TEMPLATE_KEY_DEFAULT,
      label: t('reminderTemplates.defaultLabel', 'Default (catch-all)'),
      emoji: '✉️',
      isDefault: true,
      hasTemplate: reminderTemplateKeys.has(TEMPLATE_KEY_DEFAULT),
    }];
    for (const et of eventTypes) {
      const key = `${TEMPLATE_KEY_PREFIX}${et.slug_prefix}`;
      rows.push({
        key,
        label: et.name,
        emoji: et.emoji || '📅',
        isDefault: false,
        hasTemplate: reminderTemplateKeys.has(key),
      });
    }
    return rows;
  }, [eventTypes, reminderTemplateKeys, t]);

  // ---- Selection + per-template fetch ----------------------------------
  const [selectedKey, setSelectedKey] = useState<string>(TEMPLATE_KEY_DEFAULT);
  const [editingLang, setEditingLang] = useState<string>('en');

  // Default template — always loaded so per-type rows that don't exist
  // yet can prefill their form from it.
  const { data: defaultTemplate } = useQuery({
    queryKey: ['email-template', TEMPLATE_KEY_DEFAULT],
    queryFn: () => emailService.getTemplate(TEMPLATE_KEY_DEFAULT),
    enabled: reminderTemplateKeys.has(TEMPLATE_KEY_DEFAULT),
  });

  const { data: selectedTemplate, isLoading: selectedLoading } = useQuery({
    queryKey: ['email-template', selectedKey],
    queryFn: () => emailService.getTemplate(selectedKey),
    enabled: reminderTemplateKeys.has(selectedKey),
  });

  // ---- Form state ------------------------------------------------------
  // Six locales buffered locally — admin can flip between tabs without
  // losing edits. Reset whenever the selection changes.
  const emptyTranslation: EmailTemplateTranslation = { subject: '', body_html: '', body_text: '' };
  const blankAllLangs = (): Record<string, EmailTemplateTranslation> => {
    const out: Record<string, EmailTemplateTranslation> = {};
    for (const lang of SUPPORTED_LANGUAGES) out[lang.code] = { ...emptyTranslation };
    return out;
  };
  const [translations, setTranslations] = useState<Record<string, EmailTemplateTranslation>>(blankAllLangs);

  useEffect(() => {
    // Repopulate form from the resolved source:
    //   1. existing template's translations (per-type that has its own row)
    //   2. default template's translations (prefill for per-type without a row yet)
    //   3. blank fallback
    const source = selectedTemplate ?? (
      !reminderTemplateKeys.has(selectedKey) && defaultTemplate ? defaultTemplate : null
    );
    const next = blankAllLangs();
    if (source?.translations) {
      for (const lang of SUPPORTED_LANGUAGES) {
        const tr = source.translations[lang.code];
        if (tr) next[lang.code] = {
          subject: tr.subject || '',
          body_html: tr.body_html || '',
          body_text: tr.body_text || '',
        };
      }
    }
    setTranslations(next);
    setEditingLang('en');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, selectedTemplate, defaultTemplate]);

  // ---- Save -------------------------------------------------------------
  const saveMutation = useMutationWithToast({
    mutationFn: async () => {
      // Only send non-empty translations so we don't clobber DB rows
      // for locales the admin hasn't touched.
      const payloadTranslations: Record<string, EmailTemplateTranslation> = {};
      for (const lang of SUPPORTED_LANGUAGES) {
        const tr = translations[lang.code];
        const s = (tr?.subject || '').trim();
        const h = (tr?.body_html || '').trim();
        const x = (tr?.body_text || '').trim();
        if (s || h || x) payloadTranslations[lang.code] = tr;
      }
      if (reminderTemplateKeys.has(selectedKey)) {
        await emailService.updateTemplate(selectedKey, { translations: payloadTranslations });
      } else {
        await emailService.createTemplate({
          template_key: selectedKey,
          translations: payloadTranslations,
          category: 'crm',
          subcategory: 'event_reminder',
          feature_flag: 'crm_event_reminders_enabled',
          variables: VARIABLES,
        });
      }
    },
    successMessage: t('reminderTemplates.saved', 'Template saved.'),
    invalidateKeys: [['email-templates'], ['email-template', selectedKey]],
    errorMessage: t('reminderTemplates.saveError', 'Could not save template.'),
  });

  // Translation completeness pill for the sidebar — matches the email
  // templates' "{count}/{total}" display.
  const translationCount = (key: string) => {
    const tpl = allTemplates.find((x) => x.template_key === key);
    if (!tpl?.translations) return 0;
    return SUPPORTED_LANGUAGES.filter((lang) => {
      const tr = tpl.translations[lang.code];
      return !!(tr && ((tr.subject || '').trim() || (tr.body_html || '').trim() || (tr.body_text || '').trim()));
    }).length;
  };

  const currentTranslation = translations[editingLang] || emptyTranslation;
  const setCurrentField = (field: keyof EmailTemplateTranslation, value: string) =>
    setTranslations((prev) => ({
      ...prev,
      [editingLang]: { ...prev[editingLang], [field]: value },
    }));

  const isNewPerType = !reminderTemplateKeys.has(selectedKey)
    && !sidebarRows.find((r) => r.key === selectedKey)?.isDefault;
  const totalLangs = SUPPORTED_LANGUAGES.length;

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <Link to="/admin/settings/crm" className="p-2 -ml-2 rounded hover:bg-neutral-100 dark:hover:bg-neutral-700">
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <h1 className="text-2xl font-bold text-theme">
          {t('reminderTemplates.title', 'Pre-event reminder emails')}
        </h1>
      </div>

      {/* Schedule (on/off + lead time): in Workflows when the engine is live,
          else the legacy global controls. */}
      <Card className="mb-4">
        {workflowsLive ? (
          <div className="flex items-start gap-2 text-sm text-blue-800 dark:text-blue-200">
            <WorkflowIcon className="w-4 h-4 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">{t('reminderTemplates.scheduleMoved.title', 'The reminder schedule is now in Workflows')}</p>
              <p className="mt-1 text-muted-theme">
                {t('reminderTemplates.scheduleMoved.body', 'Whether pre-event reminders are sent, and how many days before the event, is configured in the “Pre-event reminder” workflow. This page edits the email templates; per-event overrides stay on each event’s detail page.')}{' '}
                <Link to="/admin/workflows" className="underline font-medium">{t('reminderTemplates.scheduleMoved.link', 'Open Workflows')}</Link>
              </p>
            </div>
          </div>
        ) : (
          <>
            <h3 className="font-semibold text-sm mb-2">
              {t('reminderTemplates.globalSection', 'Global behaviour')}
            </h3>
            <p className="text-xs text-muted-theme mb-3">
              {t('reminderTemplates.globalHelp',
                'Off by default — turn on to start sending pre-event reminders. The offset below is the default; each event can override on its detail page.')}
            </p>
            <div className="flex items-center gap-6 flex-wrap">
              <label className="inline-flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
                {t('reminderTemplates.enableLabel', 'Send pre-event reminder emails')}
              </label>
              <div className="flex items-center gap-2">
                <label htmlFor="reminder-days-before" className="text-sm">
                  {t('reminderTemplates.daysBeforeLabel', 'Days before the event')}
                </label>
                <Input id="reminder-days-before" type="number" min={0} max={365}
                  value={daysBefore} onChange={(e) => setDaysBefore(Number(e.target.value))} className="w-24" />
              </div>
              <Button variant="outline" size="sm"
                onClick={() => saveSettingsMutation.mutate()}
                isLoading={saveSettingsMutation.isPending}
                disabled={saveSettingsMutation.isPending}
                leftIcon={<Save className="w-4 h-4" />}>
                {t('reminderTemplates.saveSettings', 'Save global settings')}
              </Button>
            </div>
          </>
        )}
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Sidebar — same shape as EmailConfigPage + BlockLibraryPage. */}
        <Card padding="sm">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
              {t('reminderTemplates.sidebarHeading', 'Templates')}
            </h3>
          </div>
          <div className="space-y-5">
            {/* Section header — single section for now ("TEMPLATES"). The
                contract block library uses 4-6 sections; we have one
                conceptual grouping (default + per-type) so we render
                one uppercase header and let the rows speak for the
                taxonomy via the "Default" pill. */}
            <div>
              <h4 className="px-1 mb-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                {t('reminderTemplates.sectionTemplates', 'Templates')}
              </h4>
              <div className="space-y-2">
                {sidebarRows.map((row) => {
                  const isSelected = row.key === selectedKey;
                  const count = translationCount(row.key);
                  return (
                    <button
                      key={row.key}
                      onClick={() => setSelectedKey(row.key)}
                      className={`w-full text-left p-3 rounded-lg transition-colors ${
                        isSelected
                          ? 'tile-selected'
                          : 'bg-neutral-50 dark:bg-neutral-700 border-2 border-transparent hover:bg-neutral-100 dark:hover:bg-neutral-600'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-base shrink-0">{row.emoji}</span>
                          <p className="font-medium text-neutral-900 dark:text-neutral-100 truncate">
                            {row.label}
                          </p>
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          {!row.hasTemplate && !row.isDefault && (
                            <span
                              className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-semibold bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                              title={t('reminderTemplates.usesDefaultTooltip',
                                'No dedicated template yet — this event type falls back to the default. Edit + save here to create one.') as string}
                            >
                              {t('reminderTemplates.usesDefault', 'Default')}
                            </span>
                          )}
                          {row.hasTemplate && (
                            <span className="text-xs px-2 py-0.5 rounded-full bg-neutral-200 dark:bg-neutral-600 text-neutral-600 dark:text-neutral-300">
                              {count}/{totalLangs}
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </Card>

        {/* Right panel — edit form, lg:col-span-2 to match the email +
            contract editor proportions. */}
        <div className="lg:col-span-2">
          <Card padding="md">
            {selectedLoading ? <Loading /> : (
              <>
                <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
                  <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
                    {sidebarRows.find((r) => r.key === selectedKey)?.label || selectedKey}
                  </h3>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => saveMutation.mutate()}
                    isLoading={saveMutation.isPending}
                    disabled={saveMutation.isPending}
                    leftIcon={<Save className="w-4 h-4" />}
                  >
                    {t('reminderTemplates.saveTemplate', 'Save template')}
                  </Button>
                </div>

                {/* Language tabs — full SUPPORTED_LANGUAGES row with
                    flags and an amber bullet on locales the admin
                    hasn't filled. */}
                <div className="flex flex-wrap gap-1 mb-4 p-1 bg-neutral-100 dark:bg-neutral-700 rounded-lg">
                  {SUPPORTED_LANGUAGES.map((lang) => {
                    const tr = translations[lang.code];
                    const filled = !!(tr && ((tr.subject || '').trim() || (tr.body_html || '').trim()));
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
                        <lang.Flag />
                        <span>{lang.name}</span>
                        {!filled && lang.code !== 'en' && (
                          <span
                            className="w-1.5 h-1.5 rounded-full bg-amber-400"
                            title={t('reminderTemplates.noTranslation', 'No translation yet') as string}
                          />
                        )}
                      </button>
                    );
                  })}
                </div>

                {isNewPerType && (
                  <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700 p-3 mb-3 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-700 dark:text-amber-300 mt-0.5 shrink-0" />
                    <p className="text-sm text-amber-800 dark:text-amber-200">
                      {t('reminderTemplates.willCreateOnSave',
                        'This event type uses the default template. The fields below are pre-filled from the default; saving will create a dedicated template for this event type.')}
                    </p>
                  </div>
                )}

                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                      {t('reminderTemplates.subjectLabel', 'Subject')} ({SUPPORTED_LANGUAGES.find((l) => l.code === editingLang)?.name || editingLang})
                    </label>
                    <Input
                      type="text"
                      value={currentTranslation.subject || ''}
                      onChange={(e) => setCurrentField('subject', e.target.value)}
                      placeholder={t('reminderTemplates.subjectPlaceholder', 'Email subject') as string}
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                      {t('reminderTemplates.bodyLabel', 'Body')} ({SUPPORTED_LANGUAGES.find((l) => l.code === editingLang)?.name || editingLang})
                    </label>
                    <EmailTemplateEditor
                      content={currentTranslation.body_html || ''}
                      onChange={(value) => setCurrentField('body_html', value)}
                      variables={VARIABLES}
                    />
                  </div>

                  <p className="text-xs text-muted-theme">
                    {t('reminderTemplates.variablesHint',
                      'Available variables: {{customer_name}}, {{event_name}}, {{event_date}}, {{event_type}}, {{days_before}}, {{business_name}} — substituted when the email is rendered.')}
                  </p>
                </div>
              </>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
};

export default ReminderTemplatesPage;
