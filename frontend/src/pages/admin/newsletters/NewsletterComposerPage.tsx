/**
 * Clients → Newsletters → composer (#1264).
 *
 * Three columns: content, recipients, preview & send.
 *
 * The recipient count is a live server-side dry run rather than a
 * client-side estimate — the number in the confirm dialog has to be the
 * number the server will actually mail, including its opt-out filtering, or
 * the confirmation is theatre.
 *
 * The preview renders in a `sandbox`-ed iframe with no `allow-scripts`. The
 * body is already sanitized server-side; this is defence in depth, and it is
 * the only place campaign HTML is ever put in a DOM.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Save, Send, TestTube2, Users, Eye, ArrowLeft } from 'lucide-react';
import { toast } from 'react-toastify';

import { Button, Card, Input, Loading, useConfirm } from '../../../components/common';
import { EmailTemplateEditor } from '../../../components/admin/EmailTemplateEditor';
import {
  newslettersService, type Campaign, type RecipientMode,
} from '../../../services/newsletters.service';
import { customerAdminService } from '../../../services/customerAdmin.service';

/** Variables the server substitutes per recipient. */
const VARIABLES = [
  'customer_name', 'first_name', 'last_name', 'salutation',
  'company_name', 'support_email', 'unsubscribe_url',
];

export const NewsletterComposerPage: React.FC = () => {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const campaignId = Number(id);
  const navigate = useNavigate();
  const confirm = useConfirm();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['newsletter', campaignId],
    queryFn: () => newslettersService.get(campaignId),
    enabled: Number.isFinite(campaignId),
  });

  const [draft, setDraft] = useState<Campaign | null>(null);
  useEffect(() => { if (data?.campaign) setDraft(data.campaign); }, [data]);

  const [testEmail, setTestEmail] = useState('');
  const [previewHtml, setPreviewHtml] = useState('');
  const [showCss, setShowCss] = useState(false);

  const patch = (changes: Partial<Campaign>) =>
    setDraft((prev) => (prev ? { ...prev, ...changes } : prev));

  // ---- recipients dry run -------------------------------------------------
  // Re-runs whenever the recipient rule changes, so the count on screen and
  // the count in the confirm dialog are always the server's own answer.
  const { data: resolution, refetch: refetchRecipients } = useQuery({
    queryKey: ['newsletter-recipients', campaignId],
    queryFn: () => newslettersService.resolveRecipients(campaignId),
    enabled: Number.isFinite(campaignId) && !!draft,
  });

  const { data: customers } = useQuery({
    queryKey: ['customers-for-newsletter'],
    queryFn: () => customerAdminService.list(),
    enabled: draft?.recipientMode === 'manual',
  });

  const save = useMutation({
    mutationFn: async () => {
      if (!draft) throw new Error('no draft');
      return newslettersService.update(campaignId, {
        name: draft.name,
        subject: draft.subject,
        bodyHtml: draft.bodyHtml,
        bodyCss: draft.bodyCss,
        language: draft.language,
        recipientMode: draft.recipientMode,
        customerIds: draft.customerIds,
        sendRatePerMinute: draft.sendRatePerMinute,
      });
    },
    onSuccess: (campaign) => {
      setDraft(campaign);
      queryClient.invalidateQueries({ queryKey: ['newsletter', campaignId] });
      queryClient.invalidateQueries({ queryKey: ['newsletters'] });
      refetchRecipients();
    },
  });

  // Every server-side action below renders or sends the STORED campaign, but
  // the editor's state lives in `draft` until Save runs. Previewing, testing
  // or queueing straight after an edit therefore acted on the previous
  // version — the operator would proof one body and mail another. Persist
  // first, always, so what is checked is what goes out.
  const persistDraft = () => save.mutateAsync();

  const loadPreview = async () => {
    try {
      await persistDraft();
      const res = await newslettersService.preview(campaignId, {});
      setPreviewHtml(res.html);
    } catch {
      toast.error(t('newsletters.previewFailed', 'Could not render the preview.'));
    }
  };

  const sendTest = async () => {
    try {
      await persistDraft();
      await newslettersService.sendTest(campaignId, testEmail);
      toast.success(t('newsletters.testSent', 'Test email sent to {{to}}.', { to: testEmail }));
    } catch {
      toast.error(t('newsletters.testFailed', 'Could not send the test email.'));
    }
  };

  const queueCampaign = async () => {
    // Save BEFORE resolving the count and confirming: the dialog must quote
    // the recipient rule that is about to be used, not the one from before
    // the operator's last edit.
    try {
      await persistDraft();
      await refetchRecipients();
    } catch {
      toast.error(t('newsletters.saveFailed', 'Could not save the campaign.'));
      return;
    }
    const count = resolution?.recipientCount ?? 0;
    const ok = await confirm({
      title: t('newsletters.queueTitle', 'Send this campaign?') as string,
      message: t('newsletters.queueBody',
        'This will email {{count}} customers at {{rate}} per minute (roughly {{minutes}} min). It cannot be undone once messages start going out.',
        {
          count,
          rate: draft?.sendRatePerMinute ?? 20,
          minutes: resolution?.estimatedMinutes ?? 1,
        }) as string,
      confirmLabel: t('newsletters.queueConfirm', 'Send to {{count}} customers', { count }) as string,
      variant: 'danger',
    });
    if (!ok) return;
    try {
      await newslettersService.queue(campaignId);
      queryClient.invalidateQueries({ queryKey: ['newsletters'] });
      toast.success(t('newsletters.queued', 'Campaign queued.'));
      navigate(`/admin/clients/newsletters/${campaignId}`);
    } catch {
      toast.error(t('newsletters.queueFailed', 'Could not queue the campaign.'));
    }
  };

  // A campaign with no subject, no body or nobody to send to must not be
  // sendable — the button is the last place to catch that before 2 000
  // people get a blank email.
  const canQueue = useMemo(() => Boolean(
    draft
    && draft.status === 'draft'
    && draft.subject.trim()
    && draft.bodyHtml.trim()
    && (resolution?.recipientCount ?? 0) > 0
  ), [draft, resolution]);

  if (isLoading || !draft) return <Loading />;

  if (draft.status !== 'draft') {
    return (
      <Card>
        <p className="text-neutral-700 dark:text-neutral-300">
          {t('newsletters.notEditable',
            'This campaign has already been queued and can no longer be edited.')}
        </p>
        <Button
          variant="outline"
          className="mt-4"
          onClick={() => navigate(`/admin/clients/newsletters/${campaignId}`)}
        >
          {t('newsletters.viewCampaign', 'View campaign')}
        </Button>
      </Card>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6 gap-4">
        <button
          type="button"
          onClick={() => navigate('/admin/clients/newsletters')}
          className="flex items-center gap-1 text-sm text-neutral-600 dark:text-neutral-400 hover:underline"
        >
          <ArrowLeft className="w-4 h-4" />
          {t('newsletters.backToList', 'All campaigns')}
        </button>
        <Button
          onClick={async () => {
            try {
              await persistDraft();
              toast.success(t('newsletters.saved', 'Campaign saved.'));
            } catch {
              toast.error(t('newsletters.saveFailed', 'Could not save the campaign.'));
            }
          }}
          isLoading={save.isPending}
          leftIcon={<Save className="w-4 h-4" />}
        >
          {t('common.save', 'Save')}
        </Button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* ---- 1. Content ---- */}
        <Card>
          <h3 className="font-semibold mb-4 text-neutral-900 dark:text-neutral-100">
            {t('newsletters.section.content', 'Content')}
          </h3>
          <div className="space-y-4">
            <Input
              label={t('newsletters.field.name', 'Campaign name (internal)') as string}
              value={draft.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
            <Input
              label={t('newsletters.field.subject', 'Subject') as string}
              value={draft.subject}
              maxLength={255}
              onChange={(e) => patch({ subject: e.target.value })}
            />
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                {t('newsletters.field.body', 'Body')}
              </label>
              <EmailTemplateEditor
                content={draft.bodyHtml}
                onChange={(html) => patch({ bodyHtml: html })}
                variables={VARIABLES}
              />
            </div>

            <div>
              <button
                type="button"
                onClick={() => setShowCss((v) => !v)}
                className="text-sm hover:underline"
                style={{ color: 'var(--color-accent)' }}
              >
                {showCss
                  ? t('newsletters.hideCss', 'Hide custom CSS')
                  : t('newsletters.showCss', 'Custom CSS (optional)')}
              </button>
              {showCss && (
                <>
                  <textarea
                    rows={6}
                    value={draft.bodyCss}
                    onChange={(e) => patch({ bodyCss: e.target.value })}
                    placeholder=".cta { background: #5C8762; color: #fff; }"
                    className="mt-2 w-full font-mono text-xs rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-2"
                  />
                  <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                    {t('newsletters.cssHelp',
                      'Many email clients drop a <style> block — keep the important styling on inline attributes. Remote images and @import are stripped.')}
                  </p>
                </>
              )}
            </div>
          </div>
        </Card>

        {/* ---- 2. Recipients ---- */}
        <Card>
          <div className="flex items-center gap-2 mb-4">
            <Users className="w-5 h-5 text-neutral-500" />
            <h3 className="font-semibold text-neutral-900 dark:text-neutral-100">
              {t('newsletters.section.recipients', 'Recipients')}
            </h3>
          </div>

          <div className="space-y-2 mb-4">
            {(['all_active', 'manual'] as RecipientMode[]).map((mode) => (
              <label key={mode} className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="recipientMode"
                  className="mt-1"
                  checked={draft.recipientMode === mode}
                  onChange={() => patch({ recipientMode: mode })}
                />
                <span className="text-sm">
                  <span className="font-medium text-neutral-900 dark:text-neutral-100">
                    {mode === 'all_active'
                      ? t('newsletters.mode.allActive', 'All active customers')
                      : t('newsletters.mode.manual', 'Pick customers')}
                  </span>
                </span>
              </label>
            ))}
          </div>

          {draft.recipientMode === 'manual' && (
            <div className="mb-4 max-h-64 overflow-y-auto border border-neutral-200 dark:border-neutral-700 rounded-md p-2">
              {(customers ?? []).map((c) => (
                <label key={c.id} className="flex items-center gap-2 py-1 cursor-pointer text-sm">
                  <input
                    type="checkbox"
                    checked={draft.customerIds.includes(c.id)}
                    onChange={(e) => patch({
                      customerIds: e.target.checked
                        ? [...draft.customerIds, c.id]
                        : draft.customerIds.filter((x) => x !== c.id),
                    })}
                  />
                  <span className="text-neutral-800 dark:text-neutral-200">
                    {c.displayName || c.email}
                  </span>
                </label>
              ))}
            </div>
          )}

          {/* The server's own count, not a local estimate. */}
          <div
            data-testid="recipient-summary"
            className="rounded-md bg-neutral-50 dark:bg-neutral-800/60 p-3 text-sm"
          >
            <p className="font-medium text-neutral-900 dark:text-neutral-100">
              {t('newsletters.recipientCount', '{{count}} recipients',
                { count: resolution?.recipientCount ?? 0 })}
            </p>
            {(resolution?.skippedOptOut ?? 0) > 0 && (
              <p className="text-neutral-600 dark:text-neutral-400 mt-1">
                {t('newsletters.skippedOptOut', '{{count}} skipped (opted out)',
                  { count: resolution?.skippedOptOut ?? 0 })}
              </p>
            )}
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-2">
              {t('newsletters.saveToRefresh', 'Save to refresh this count.')}
            </p>
          </div>

          <div className="mt-4">
            <Input
              type="number"
              min={1}
              max={120}
              label={t('newsletters.field.rate', 'Send rate (emails per minute)') as string}
              value={String(draft.sendRatePerMinute)}
              onChange={(e) => patch({ sendRatePerMinute: Number(e.target.value) })}
            />
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              {t('newsletters.rateHelp',
                'Sends are spread out so your mail provider does not rate-limit you. Check your provider\'s hourly cap before raising this.')}
            </p>
          </div>
        </Card>

        {/* ---- 3. Preview & send ---- */}
        <Card>
          <div className="flex items-center gap-2 mb-4">
            <Eye className="w-5 h-5 text-neutral-500" />
            <h3 className="font-semibold text-neutral-900 dark:text-neutral-100">
              {t('newsletters.section.preview', 'Preview & send')}
            </h3>
          </div>

          <Button variant="outline" onClick={loadPreview} className="w-full mb-3">
            {t('newsletters.refreshPreview', 'Refresh preview')}
          </Button>

          {previewHtml && (
            <iframe
              data-testid="newsletter-preview"
              title={t('newsletters.previewTitle', 'Newsletter preview') as string}
              // No allow-scripts. The body is sanitized server-side; this is
              // the second line of defence, and it is the only DOM campaign
              // HTML ever reaches.
              sandbox=""
              srcDoc={previewHtml}
              className="w-full h-96 border border-neutral-200 dark:border-neutral-700 rounded-md bg-white"
            />
          )}

          <div className="mt-4 pt-4 border-t border-neutral-200 dark:border-neutral-700 space-y-3">
            <div className="flex gap-2 items-end">
              <div className="flex-1">
                <Input
                  type="email"
                  label={t('newsletters.field.testTo', 'Send a test to') as string}
                  value={testEmail}
                  onChange={(e) => setTestEmail(e.target.value)}
                  placeholder="you@example.com"
                />
              </div>
              <Button
                variant="outline"
                onClick={sendTest}
                disabled={!testEmail}
                leftIcon={<TestTube2 className="w-4 h-4" />}
              >
                {t('newsletters.sendTest', 'Test')}
              </Button>
            </div>

            <Button
              onClick={queueCampaign}
              disabled={!canQueue}
              className="w-full"
              leftIcon={<Send className="w-4 h-4" />}
            >
              {t('newsletters.queueButton', 'Queue campaign')}
            </Button>
            {!canQueue && (
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                {t('newsletters.queueBlocked',
                  'A subject, a body and at least one recipient are needed before sending.')}
              </p>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
};
