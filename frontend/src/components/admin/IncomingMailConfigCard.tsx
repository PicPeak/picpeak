/**
 * Incoming mail (IMAP) configuration — a second block under the outgoing SMTP
 * settings, styled to match the SMTP card (icon inputs, password eye toggle,
 * full-width Save). Shown only when the `incomingMail` feature flag is on.
 *
 * The Folder field auto-detects: "Detect folders" lists the mailboxes on the
 * server and offers them as a dropdown (auto-selecting the inbox), instead of
 * making the admin type a path.
 */
import React, { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { Save, Server, User, Lock, Eye, EyeOff, FolderSearch, PlugZap, Mailbox, RefreshCw } from 'lucide-react';
import { Button, Card, Input, Loading } from '../common';
import { emailService, type IncomingMailConfig, type ImapFolder } from '../../services/email.service';

const labelCls = 'block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1';
const selectCls = 'w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-accent-dark';

export const IncomingMailConfigCard: React.FC = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['incoming-mail-config'], queryFn: () => emailService.getIncomingConfig() });
  const [cfg, setCfg] = useState<IncomingMailConfig>({ imap_host: '', imap_port: 993, imap_secure: true, imap_user: '', imap_pass: '', imap_folder: 'INBOX' });
  const [showPassword, setShowPassword] = useState(false);
  const [folders, setFolders] = useState<ImapFolder[] | null>(null);

  useEffect(() => { if (data) setCfg(data); }, [data]);

  const set = (k: keyof IncomingMailConfig, v: any) => setCfg((c) => ({ ...c, [k]: v }));

  const save = useMutation({
    mutationFn: () => {
      // Mirror the SMTP card's client-side required guard. Host + port +
      // username are needed for the poller to authenticate (getImapConfig
      // returns null without host+user).
      if (!cfg.imap_host || !cfg.imap_port || !cfg.imap_user) {
        return Promise.reject(new Error(t('email.incoming.requiredFields', 'Host, port and username are required.')));
      }
      return emailService.updateIncomingConfig(cfg);
    },
    onSuccess: () => { toast.success(t('email.incoming.savedToast', 'Incoming mail settings saved.')); qc.invalidateQueries({ queryKey: ['incoming-mail-config'] }); },
    onError: (e: any) => toast.error(e?.response?.data?.error || e?.response?.data?.errors?.[0]?.msg || e.message || 'Failed'),
  });

  const test = useMutation({
    mutationFn: () => emailService.testIncoming(cfg),
    onSuccess: (r) => toast.success(t('email.incoming.testOk', 'Connected to {{folder}} — {{messages}} messages, {{unseen}} unread.', { folder: r.folder, messages: r.messages, unseen: r.unseen })),
    onError: (e: any) => toast.error(e?.response?.data?.error || e.message || t('email.incoming.testFailed', 'Connection failed.')),
  });

  const roundTrip = useMutation({
    mutationFn: () => emailService.roundTripIncoming(),
    onSuccess: (r) => toast.success(t('email.incoming.roundTripOk', 'Round-trip OK — delivered to {{recipient}} in {{seconds}}s.', { recipient: r.recipient, seconds: r.seconds })),
    onError: (e: any) => toast.error(e?.response?.data?.error || e.message || t('email.incoming.roundTripFailed', 'Round-trip test failed.')),
  });

  const poll = useMutation({
    mutationFn: () => emailService.pollIncoming(),
    onSuccess: (r) => {
      if (r.skipped === 'disabled') {
        toast.info(t('email.incoming.pollDisabled', 'Incoming mail is turned off — enable it under Settings → Features.'));
      } else if (r.skipped === 'unconfigured') {
        toast.info(t('email.incoming.pollUnconfigured', 'Save the incoming mail settings first.'));
      } else if (r.skipped === 'busy') {
        toast.info(t('email.incoming.pollBusy', 'A poll is already running — try again in a moment.'));
      } else {
        toast.success(t('email.incoming.pollOk', 'Checked mailbox — {{count}} new email(s) ingested.', { count: r.processed || 0 }));
        qc.invalidateQueries({ queryKey: ['received-emails'] });
      }
    },
    onError: (e: any) => toast.error(e?.response?.data?.error || e.message || t('email.incoming.pollFailed', 'Mailbox poll failed.')),
  });

  const detect = useMutation({
    mutationFn: () => emailService.listIncomingFolders(cfg),
    onSuccess: (list) => {
      setFolders(list);
      if (list.length) {
        // Auto-select the inbox (special-use '\Inbox', else a path named INBOX)
        // when the current folder isn't one of the detected ones.
        const has = list.some((f) => f.path === cfg.imap_folder);
        if (!has) {
          const inbox = list.find((f) => (f.specialUse || '').toLowerCase().includes('inbox'))
            || list.find((f) => f.path.toUpperCase() === 'INBOX') || list[0];
          if (inbox) set('imap_folder', inbox.path);
        }
        toast.success(t('email.incoming.foldersDetected', '{{count}} folders found.', { count: list.length }));
      } else {
        toast.info(t('email.incoming.noFolders', 'No folders returned by the server.'));
      }
    },
    onError: (e: any) => toast.error(e?.response?.data?.error || e.message || t('email.incoming.detectFailed', 'Could not detect folders.')),
  });

  if (isLoading) return <Loading />;

  return (
    <Card padding="md" className="mt-6">
      <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-1">{t('email.incoming.title', 'Incoming mail (IMAP)')}</h2>
      <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">{t('email.incoming.subtitle', 'A dedicated mailbox polled every minute; attachments land in Accounting → Incoming invoices.')}</p>

      <div className="space-y-4">
        <div>
          <label className={labelCls}>{t('email.incoming.host', 'IMAP Host')} <span className="text-red-500">*</span></label>
          <Input
            type="text"
            value={cfg.imap_host}
            onChange={(e) => set('imap_host', e.target.value)}
            placeholder="imap.example.com"
            leftIcon={<Server className="w-5 h-5 text-neutral-400" />}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelCls}>{t('email.incoming.port', 'Port')} <span className="text-red-500">*</span></label>
            <Input type="number" value={cfg.imap_port} onChange={(e) => set('imap_port', parseInt(e.target.value, 10) || 0)} placeholder="993" />
          </div>
          <div>
            <label className={labelCls}>{t('email.incoming.security', 'Security')}</label>
            <select className={selectCls} value={cfg.imap_secure ? 'ssl' : 'plain'} onChange={(e) => set('imap_secure', e.target.value === 'ssl')}>
              <option value="ssl">{t('email.incoming.ssl', 'SSL/TLS')}</option>
              <option value="plain">{t('email.incoming.plain', 'None / STARTTLS')}</option>
            </select>
          </div>
        </div>

        <div>
          <label className={labelCls}>{t('email.incoming.user', 'Username')} <span className="text-red-500">*</span></label>
          <Input
            type="text"
            value={cfg.imap_user}
            onChange={(e) => set('imap_user', e.target.value)}
            autoComplete="off"
            placeholder="rechnungen@yourdomain.com"
            leftIcon={<User className="w-5 h-5 text-neutral-400" />}
          />
        </div>

        <div>
          <label className={labelCls}>{t('email.incoming.pass', 'Password')}</label>
          <div className="relative">
            <Input
              type={showPassword ? 'text' : 'password'}
              value={cfg.imap_pass}
              onChange={(e) => set('imap_pass', e.target.value)}
              autoComplete="new-password"
              placeholder={t('email.enterPassword', 'Enter password')}
              leftIcon={<Lock className="w-5 h-5 text-neutral-400" />}
            />
            <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-3 text-neutral-400 hover:text-neutral-600">
              {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
            </button>
          </div>
        </div>

        <div>
          <label className={labelCls}>{t('email.incoming.folder', 'Folder')}</label>
          <div className="flex gap-2">
            {folders && folders.length > 0 ? (
              <select className={selectCls} value={cfg.imap_folder} onChange={(e) => set('imap_folder', e.target.value)}>
                {folders.some((f) => f.path === cfg.imap_folder) ? null : <option value={cfg.imap_folder}>{cfg.imap_folder}</option>}
                {folders.map((f) => <option key={f.path} value={f.path}>{f.path}</option>)}
              </select>
            ) : (
              <Input type="text" value={cfg.imap_folder} onChange={(e) => set('imap_folder', e.target.value)} placeholder="INBOX" />
            )}
            <Button
              variant="outline"
              onClick={() => detect.mutate()}
              isLoading={detect.isPending}
              disabled={!cfg.imap_host || !cfg.imap_user}
              leftIcon={<FolderSearch className="w-4 h-4" />}
              className="whitespace-nowrap"
            >
              {t('email.incoming.detectFolders', 'Detect')}
            </Button>
          </div>
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{t('email.incoming.folderHint', 'Enter host, username and password, then Detect to list the mailbox folders.')}</p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => test.mutate()}
            isLoading={test.isPending}
            disabled={!cfg.imap_host || !cfg.imap_user}
            leftIcon={<PlugZap className="w-5 h-5" />}
            className="whitespace-nowrap"
          >
            {t('email.incoming.test', 'Test connection')}
          </Button>
          <Button
            variant="outline"
            onClick={() => roundTrip.mutate()}
            isLoading={roundTrip.isPending}
            disabled={!cfg.imap_host || !cfg.imap_user}
            leftIcon={<Mailbox className="w-5 h-5" />}
            className="whitespace-nowrap"
            title={t('email.incoming.roundTripHint', 'Sends a test email via your SMTP settings to this mailbox and confirms it arrives. Save both first.') as string}
          >
            {t('email.incoming.roundTrip', 'Round-trip test')}
          </Button>
          <Button
            variant="outline"
            onClick={() => poll.mutate()}
            isLoading={poll.isPending}
            disabled={!cfg.imap_host || !cfg.imap_user}
            leftIcon={<RefreshCw className="w-5 h-5" />}
            className="whitespace-nowrap"
            title={t('email.incoming.pollHint', 'Check the mailbox now instead of waiting for the 60-second poll. Ingests unread attachments into Incoming invoices.') as string}
          >
            {t('email.incoming.poll', 'Check now')}
          </Button>
          <Button variant="primary" onClick={() => save.mutate()} isLoading={save.isPending} leftIcon={<Save className="w-5 h-5" />} className="flex-1 min-w-[12rem]">
            {t('email.incoming.save', 'Save Incoming Mail Settings')}
          </Button>
        </div>
      </div>
    </Card>
  );
};

export default IncomingMailConfigCard;
