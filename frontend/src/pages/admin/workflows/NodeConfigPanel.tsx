/**
 * Structured config editor for a workflow node — dropdowns + typed fields per
 * node type, so admins don't hand-edit JSON. An "Advanced (JSON)" expander is
 * kept for power users / config the form doesn't cover. Changes are applied
 * live to the node (the global Save persists them).
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

type Cfg = Record<string, any>;

interface WebhookOption { id: number; name: string; active: boolean }

interface Props {
  nodeType: string;
  config: Cfg;
  onChange: (next: Cfg) => void;
  webhooks?: WebhookOption[];
}

const field = 'w-full px-2 py-1.5 rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 text-sm';
const lbl = 'block text-xs text-neutral-500 dark:text-neutral-400 mb-1';

const ACTIONS = [
  ['queue_payment_check', 'Send payment-check email (dunning gate)'],
  ['escalate_to_collections', 'Hand off to collections (email admin)'],
  ['send_email', 'Send email'],
  ['notify_pre_event', 'Send pre-event reminder'],
  ['notify_gallery_expiring', 'Send gallery-expiring warning'],
  ['notify_gallery_expired', 'Send gallery-expired email'],
  ['reserve_date', 'Reserve the event date'],
  ['prepare_quote', 'Prepare a quote (draft)'],
  ['prepare_contract', 'Prepare a contract (draft)'],
  ['prepare_invoice', 'Prepare an invoice (draft)'],
  ['prepare_event', 'Create an event (draft)'],
  ['prepare_gallery', 'Create a gallery (draft)'],
  ['send_document', 'Send the document'],
  ['webhook', 'Call a webhook'],
  ['noop', 'Do nothing'],
];
const CONDITIONS = [
  ['invoice_paid', 'Invoice is paid'],
  ['expr', 'Compare a field'],
  ['always', 'Always → yes'],
  ['never', 'Never → no'],
];
const WAIT_ANCHORS = [
  ['dueDate', 'the invoice due date'],
  ['issueDate', 'the invoice date'],
  ['eventDate', 'the event date'],
];
const OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'truthy', 'falsy'];

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div><label className={lbl}>{label}</label>{children}</div>
);

export const NodeConfigPanel: React.FC<Props> = ({ nodeType, config, onChange, webhooks = [] }) => {
  const { t } = useTranslation();
  const [showJson, setShowJson] = useState(false);
  const [jsonText, setJsonText] = useState(JSON.stringify(config || {}, null, 2));
  const [jsonErr, setJsonErr] = useState<string | null>(null);

  const set = (patch: Cfg) => onChange({ ...config, ...patch });
  const num = (v: string) => (v === '' ? undefined : Number(v));

  const applyJson = (text: string) => {
    setJsonText(text);
    try { onChange(JSON.parse(text || '{}')); setJsonErr(null); }
    catch (e) { setJsonErr(t('workflows.editor.badJson', 'Config is not valid JSON') as string); }
  };

  const waitMode = config.untilVar ? 'until' : 'delay';

  return (
    <div className="space-y-3">
      {nodeType === 'trigger' && (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {t('workflows.editor.triggerHint', 'The trigger is set in the toolbar above (When …).')}
        </p>
      )}

      {(nodeType === 'action' || nodeType === 'webhook') && (
        <Row label={t('workflows.editor.actionLabel', 'Action')}>
          <select className={field} value={config.action || (nodeType === 'webhook' ? 'webhook' : 'noop')} onChange={(e) => set({ action: e.target.value })}>
            {ACTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Row>
      )}

      {nodeType === 'action' && config.action === 'send_email' && (
        <>
          <Row label={t('workflows.editor.recipient', 'Recipient')}>
            <select className={field} value={config.recipientClass || 'customer'} onChange={(e) => set({ recipientClass: e.target.value })}>
              <option value="customer">{t('workflows.editor.recipientCustomer', 'Customer (respects business hours)')}</option>
              <option value="admin">{t('workflows.editor.recipientAdmin', 'Admin (sent immediately)')}</option>
            </select>
          </Row>
          <Row label={t('workflows.editor.emailTemplate', 'Email template key')}>
            <input className={field} value={config.emailType || ''} onChange={(e) => set({ emailType: e.target.value })} placeholder="invoice_reminder" />
          </Row>
        </>
      )}

      {nodeType === 'action' && config.action === 'notify_pre_event' && (
        <Row label={t('workflows.editor.templateGroup', 'Reminder template group')}>
          <input className={field} value={config.templateGroup || ''} onChange={(e) => set({ templateGroup: e.target.value })} placeholder="event_reminder" />
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
            {t('workflows.editor.templateGroupHint', 'The exact template is auto-picked per event type within this group: «group»_«eventType» if you authored one, else «group»_default. Blank = event_reminder.')}
          </p>
        </Row>
      )}

      {(nodeType === 'action' || nodeType === 'webhook') && (config.action === 'webhook' || nodeType === 'webhook') && (
        <Row label={t('workflows.editor.webhookTarget', 'Webhook')}>
          <select className={field} value={config.webhookId ?? ''} onChange={(e) => set({ webhookId: e.target.value ? Number(e.target.value) : undefined })}>
            <option value="">{t('workflows.editor.webhookNone', '— Select a configured webhook —')}</option>
            {webhooks.map((w) => (
              <option key={w.id} value={w.id}>{w.name}{w.active ? '' : ` ${t('workflows.editor.webhookInactive', '(inactive)')}`}</option>
            ))}
          </select>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
            {t('workflows.editor.webhookHint', 'Delivered via the webhook pipeline (signing, retries, SSRF checks). Manage endpoints in Settings → Webhooks.')}
          </p>
        </Row>
      )}

      {(nodeType === 'condition' || nodeType === 'branch') && (
        <>
          <Row label={t('workflows.editor.condition', 'Condition')}>
            <select className={field} value={config.condition || 'expr'} onChange={(e) => set({ condition: e.target.value })}>
              {CONDITIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Row>
          {config.condition === 'expr' && (
            <>
              <Row label={t('workflows.editor.exprField', 'Field')}>
                <input className={field} value={config.field || ''} onChange={(e) => set({ field: e.target.value })} />
              </Row>
              <Row label={t('workflows.editor.exprOp', 'Operator')}>
                <select className={field} value={config.op || 'truthy'} onChange={(e) => set({ op: e.target.value })}>
                  {OPS.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </Row>
              {!['truthy', 'falsy'].includes(config.op) && (
                <Row label={t('workflows.editor.exprValue', 'Value')}>
                  <input className={field} value={config.value ?? ''} onChange={(e) => set({ value: e.target.value })} />
                </Row>
              )}
            </>
          )}
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {t('workflows.editor.conditionHint', 'Routes to the “yes” edge when true, “no” when false.')}
          </p>
        </>
      )}

      {nodeType === 'wait' && (
        <>
          <Row label={t('workflows.editor.waitType', 'Wait')}>
            <select
              className={field}
              value={waitMode}
              onChange={(e) => (e.target.value === 'until'
                ? onChange({ untilVar: 'dueDate' })
                : onChange({ delayDays: config.delayDays || 1 }))}
            >
              <option value="until">{t('workflows.editor.waitUntil', 'Until a date')}</option>
              <option value="delay">{t('workflows.editor.waitDelay', 'A fixed delay')}</option>
            </select>
          </Row>
          {waitMode === 'until' ? (
            <Row label={t('workflows.editor.waitAnchor', 'Wait until')}>
              <select className={field} value={config.untilVar || 'dueDate'} onChange={(e) => onChange({ untilVar: e.target.value })}>
                {WAIT_ANCHORS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Row>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              <Row label={t('workflows.editor.days', 'Days')}>
                <input type="number" min={0} className={field} value={config.delayDays ?? ''} onChange={(e) => set({ delayDays: num(e.target.value) })} />
              </Row>
              <Row label={t('workflows.editor.hours', 'Hours')}>
                <input type="number" min={0} className={field} value={config.delayHours ?? ''} onChange={(e) => set({ delayHours: num(e.target.value) })} />
              </Row>
              <Row label={t('workflows.editor.minutes', 'Min')}>
                <input type="number" min={0} className={field} value={config.delayMinutes ?? ''} onChange={(e) => set({ delayMinutes: num(e.target.value) })} />
              </Row>
            </div>
          )}
        </>
      )}

      {nodeType === 'loop' && (
        <Row label={t('workflows.editor.maxIterations', 'Repeat at most (times)')}>
          <input type="number" min={1} className={field} value={config.maxIterations ?? 3} onChange={(e) => set({ maxIterations: num(e.target.value) })} />
        </Row>
      )}

      {nodeType === 'gate' && (
        <>
          <Row label={t('workflows.editor.gatePrompt', 'Question for the admin')}>
            <textarea className={field} rows={2} value={config.prompt || ''} onChange={(e) => set({ prompt: e.target.value })} placeholder={t('workflows.editor.gatePromptPh', 'e.g. No payment received — send a reminder?') as string} />
          </Row>
          <Row label={t('workflows.editor.gateTimeout', 'Auto-expire after (days, optional)')}>
            <input type="number" min={0} className={field} value={config.timeoutDays ?? ''} onChange={(e) => set({ timeoutDays: num(e.target.value) })} />
          </Row>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {t('workflows.editor.gateHint', 'Emails the admin a confirm/deny link; routes to the “confirm” or “deny” edge.')}
          </p>
        </>
      )}

      <button type="button" className="text-xs text-neutral-500 dark:text-neutral-400 underline" onClick={() => { setJsonText(JSON.stringify(config || {}, null, 2)); setShowJson((s) => !s); }}>
        {showJson ? t('workflows.editor.hideAdvanced', 'Hide advanced (JSON)') : t('workflows.editor.showAdvanced', 'Advanced (JSON)')}
      </button>
      {showJson && (
        <div className="space-y-1">
          <textarea className={`${field} font-mono`} rows={8} value={jsonText} onChange={(e) => applyJson(e.target.value)} />
          {jsonErr && <p className="text-xs text-red-600 dark:text-red-400">{jsonErr}</p>}
        </div>
      )}
    </div>
  );
};
