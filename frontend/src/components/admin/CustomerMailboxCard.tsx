/**
 * Customer mailbox (hello@) configuration — a second inbound IMAP box beyond
 * the accounting rechnungen@ one, stored in `mail_accounts` under the fixed
 * account_key 'customers'. Its mail feeds Messages → Customers ▸ Inbox (body
 * captured, attachments NOT routed to accounting). Shown when the `messaging`
 * feature flag is on. Styled to match the Incoming Mail card.
 */
import React, { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Save, Server, User, Lock, Eye, EyeOff, PlugZap, Inbox } from 'lucide-react';
import { Button, Card, Input, Loading } from '../common';
import { emailService, type MailAccount } from '../../services/email.service';
import { useMutationWithToast, useModal } from '../../hooks';

const labelCls = 'block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1';
const selectCls = 'w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-accent-dark';

const ACCOUNT_KEY = 'customers';

export const CustomerMailboxCard: React.FC = () => {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery({ queryKey: ['mail-accounts'], queryFn: () => emailService.listMailAccounts() });
  const [cfg, setCfg] = useState<MailAccount>({ account_key: ACCOUNT_KEY, imap_host: '', imap_port: 993, imap_secure: true, imap_user: '', imap_pass: '', imap_folder: 'INBOX', enabled: false });
  const passwordVisibility = useModal();

  useEffect(() => {
    if (!data) return;
    const row = data.find((a) => a.account_key === ACCOUNT_KEY);
    if (row) setCfg({ ...row, imap_pass: row.imap_pass || '' });
  }, [data]);

  const set = (k: keyof MailAccount, v: any) => setCfg((c) => ({ ...c, [k]: v }));

  const save = useMutationWithToast({
    mutationFn: () => {
      if (!cfg.imap_host || !cfg.imap_port || !cfg.imap_user) {
        return Promise.reject(new Error(t('email.customerMailbox.requiredFields', 'Host, port and username are required.')));
      }
      return emailService.saveMailAccount({ ...cfg, account_key: ACCOUNT_KEY, label: 'Customers' });
    },
    successMessage: t('email.customerMailbox.savedToast', 'Customer mailbox saved.'),
    invalidateKeys: [['mail-accounts']],
    errorMessage: (e: any) => e?.response?.data?.error || e.message || 'Failed',
  });

  const test = useMutationWithToast({
    mutationFn: () => emailService.testMailAccount({ ...cfg, account_key: ACCOUNT_KEY }),
    successMessage: (r) => t('email.customerMailbox.testOk', 'Connected to {{folder}} — {{messages}} messages, {{unseen}} unread.', { folder: r.folder, messages: r.messages, unseen: r.unseen }),
    errorMessage: (e: any) => e?.response?.data?.error || e.message || t('email.customerMailbox.testFailed', 'Connection failed.'),
  });

  if (isLoading) return <Loading />;

  return (
    <Card padding="md" className="mt-6">
      <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-1 flex items-center gap-2">
        <Inbox className="w-5 h-5 text-neutral-400" />
        {t('email.customerMailbox.title', 'Customer mailbox (hello@)')}
      </h2>
      <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
        {t('email.customerMailbox.subtitle', 'A second inbound mailbox for customer conversations. Its mail appears under Messages → Customers; attachments are not routed to Accounting.')}
      </p>

      <div className="space-y-4">
        <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
          <input type="checkbox" checked={!!cfg.enabled} onChange={(e) => set('enabled', e.target.checked)} />
          {t('email.customerMailbox.enabled', 'Poll this mailbox every minute')}
        </label>

        <div>
          <label className={labelCls}>{t('email.incoming.host', 'IMAP Host')} <span className="text-red-500">*</span></label>
          <Input type="text" value={cfg.imap_host || ''} onChange={(e) => set('imap_host', e.target.value)} placeholder="imap.example.com" leftIcon={<Server className="w-5 h-5 text-neutral-400" />} />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelCls}>{t('email.incoming.port', 'Port')} <span className="text-red-500">*</span></label>
            <Input type="number" value={cfg.imap_port ?? 993} onChange={(e) => set('imap_port', parseInt(e.target.value, 10) || 0)} placeholder="993" />
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
          <Input type="text" value={cfg.imap_user || ''} onChange={(e) => set('imap_user', e.target.value)} autoComplete="off" placeholder="hello@yourdomain.com" leftIcon={<User className="w-5 h-5 text-neutral-400" />} />
        </div>

        <div>
          <label className={labelCls}>{t('email.incoming.pass', 'Password')}</label>
          <div className="relative">
            <Input type={passwordVisibility.isOpen ? 'text' : 'password'} value={cfg.imap_pass || ''} onChange={(e) => set('imap_pass', e.target.value)} autoComplete="new-password" placeholder={t('email.enterPassword', 'Enter password')} leftIcon={<Lock className="w-5 h-5 text-neutral-400" />} />
            <button type="button" onClick={passwordVisibility.toggle} className="absolute right-3 top-3 text-neutral-400 hover:text-neutral-600">
              {passwordVisibility.isOpen ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
            </button>
          </div>
        </div>

        <div>
          <label className={labelCls}>{t('email.incoming.folder', 'Folder')}</label>
          <Input type="text" value={cfg.imap_folder || 'INBOX'} onChange={(e) => set('imap_folder', e.target.value)} placeholder="INBOX" />
        </div>

        <div className="pt-4 mt-1 border-t border-neutral-200 dark:border-neutral-700">
          <div className="text-sm font-semibold text-neutral-800 dark:text-neutral-200">
            {t('email.customerMailbox.outgoing', 'Outgoing (SMTP)')}
          </div>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5 mb-3">
            {t('email.customerMailbox.outgoingHint', 'Replies from this mailbox send from here. Leave blank to fall back to the global outgoing address.')}
          </p>
          <div className="space-y-4">
            <div>
              <label className={labelCls}>{t('email.customerMailbox.fromEmail', 'From address')}</label>
              <Input type="text" value={cfg.from_email || ''} onChange={(e) => set('from_email', e.target.value)} placeholder="hello@yourdomain.com" leftIcon={<User className="w-5 h-5 text-neutral-400" />} />
            </div>
            <div>
              <label className={labelCls}>{t('email.customerMailbox.smtpHost', 'SMTP Host')}</label>
              <Input type="text" value={cfg.smtp_host || ''} onChange={(e) => set('smtp_host', e.target.value)} placeholder="smtp.example.com" leftIcon={<Server className="w-5 h-5 text-neutral-400" />} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelCls}>{t('email.incoming.port', 'Port')}</label>
                <Input type="number" value={cfg.smtp_port ?? 587} onChange={(e) => set('smtp_port', parseInt(e.target.value, 10) || 0)} placeholder="587" />
              </div>
              <div>
                <label className={labelCls}>{t('email.incoming.security', 'Security')}</label>
                <select className={selectCls} value={cfg.smtp_secure ? 'ssl' : 'starttls'} onChange={(e) => set('smtp_secure', e.target.value === 'ssl')}>
                  <option value="ssl">{t('email.customerMailbox.smtpSsl', 'SSL (465)')}</option>
                  <option value="starttls">{t('email.customerMailbox.smtpStarttls', 'STARTTLS (587)')}</option>
                </select>
              </div>
            </div>
            <div>
              <label className={labelCls}>{t('email.customerMailbox.smtpUser', 'SMTP Username')}</label>
              <Input type="text" value={cfg.smtp_user || ''} onChange={(e) => set('smtp_user', e.target.value)} autoComplete="off" placeholder="hello@yourdomain.com" leftIcon={<User className="w-5 h-5 text-neutral-400" />} />
            </div>
            <div>
              <label className={labelCls}>{t('email.customerMailbox.smtpPass', 'SMTP Password')}</label>
              <Input type={passwordVisibility.isOpen ? 'text' : 'password'} value={cfg.smtp_pass || ''} onChange={(e) => set('smtp_pass', e.target.value)} autoComplete="new-password" placeholder={t('email.enterPassword', 'Enter password')} leftIcon={<Lock className="w-5 h-5 text-neutral-400" />} />
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => test.mutate()} isLoading={test.isPending} disabled={!cfg.imap_host || !cfg.imap_user} leftIcon={<PlugZap className="w-5 h-5" />} className="whitespace-nowrap">
            {t('email.incoming.test', 'Test connection')}
          </Button>
          <Button variant="primary" onClick={() => save.mutate()} isLoading={save.isPending} leftIcon={<Save className="w-5 h-5" />} className="flex-1 min-w-[12rem]">
            {t('email.customerMailbox.save', 'Save Customer Mailbox')}
          </Button>
        </div>
      </div>
    </Card>
  );
};

export default CustomerMailboxCard;
