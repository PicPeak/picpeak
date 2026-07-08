/**
 * Chart of accounts manager (Layer A) — embedded in Settings → Accounting.
 *
 * Full CRUD for the Swiss/LI KMU-Kontenrahmen accounts, plus the mappings the
 * Treuhänder export relies on: which account each expense category books to and
 * the default/system accounts. Sits alongside VatCodesManager so all accounting
 * configuration lives in one place.
 *
 * This data drives the export only — picpeak is not a double-entry ledger.
 *
 * NOTE: ledgerService.updateSettings is a PARTIAL merge, so this component saves
 * ONLY the account keys (SETTING_ACCOUNT_KEYS); the VAT maps are owned by
 * VatCodesManager. Scoping each patch keeps the two from reverting each other.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { X, Plus, Pencil, Trash2, AlertCircle } from 'lucide-react';
import { Button, Card, CardContent, Input, Loading } from '../common';
import {
  ledgerService, type LedgerAccount, type AccountType, type LedgerSettings,
} from '../../services/ledger.service';
import { categoryLabel } from '../../services/accounting.service';
import { useMutationWithToast } from '../../hooks';

const ACCOUNT_TYPES: AccountType[] = ['asset', 'liability', 'equity', 'revenue', 'expense'];
const labelCls = 'block text-xs font-medium text-neutral-700 dark:text-neutral-300 mb-1';
const selectCls = 'w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-2 text-sm';
const SETTING_ACCOUNT_KEYS: (keyof LedgerSettings)[] = [
  'ledger_account_debitoren', 'ledger_account_kreditoren', 'ledger_account_bank', 'ledger_account_cash',
  'ledger_account_default_revenue', 'ledger_account_default_expense',
  'ledger_account_mileage', 'ledger_account_per_diem', 'ledger_account_rebilled_revenue',
];

// ── account modal ──────────────────────────────────────────────────────
const AccountModal: React.FC<{ account?: LedgerAccount; onClose: () => void; onDone: () => void }> = ({ account, onClose, onDone }) => {
  const { t } = useTranslation();
  const isEdit = !!account;
  const [number, setNumber] = useState(account?.number ?? '');
  const [name, setName] = useState(account?.name ?? '');
  const [type, setType] = useState<AccountType>(account?.type ?? 'expense');
  const save = useMutationWithToast({
    mutationFn: () => isEdit ? ledgerService.updateAccount(account!.id, { number, name, type }) : ledgerService.createAccount({ number, name, type }),
    successMessage: t('common.saved', 'Saved.'),
    onSuccess: () => onDone(),
    errorMessage: (e: any) => e?.response?.data?.error || e.message || 'Failed',
  });
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4">
      <div className="mt-20 w-full max-w-sm rounded-xl bg-white dark:bg-neutral-900 shadow-xl">
        <div className="flex items-center justify-between border-b border-neutral-200 dark:border-neutral-700 px-5 py-3">
          <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">{isEdit ? t('ledger.account.editTitle', 'Edit account') : t('ledger.account.addTitle', 'Add account')}</h2>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-600"><X className="w-5 h-5" /></button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div><label className={labelCls}>{t('ledger.account.number', 'Account number')}</label><Input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="6700" /></div>
          <div><label className={labelCls}>{t('ledger.account.name', 'Name')}</label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div><label className={labelCls}>{t('ledger.account.type', 'Type')}</label>
            <select value={type} onChange={(e) => setType(e.target.value as AccountType)} className={selectCls}>
              {ACCOUNT_TYPES.map((tp) => <option key={tp} value={tp}>{t(`ledger.accountType.${tp}`, tp)}</option>)}
            </select>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-neutral-200 dark:border-neutral-700 px-5 py-3">
          <Button variant="outline" onClick={onClose}>{t('common.cancel', 'Cancel')}</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !number || !name}>{save.isPending ? t('common.saving', 'Saving…') : t('common.save', 'Save')}</Button>
        </div>
      </div>
    </div>
  );
};

export const ChartOfAccountsManager: React.FC = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [accountModal, setAccountModal] = useState<{ account?: LedgerAccount } | null>(null);

  const { data: accounts, isLoading: la } = useQuery({ queryKey: ['ledger-accounts'], queryFn: () => ledgerService.listAccounts() });
  const { data: mappings, isLoading: lm } = useQuery({ queryKey: ['ledger-mappings'], queryFn: () => ledgerService.getMappings() });

  // Local editable copy of the settings (default/system accounts only).
  const [settings, setSettings] = useState<LedgerSettings>({});
  useEffect(() => { if (mappings?.settings) setSettings(mappings.settings); }, [mappings?.settings]);

  const accountOptions = useMemo(() => (accounts ?? []).filter((a) => a.active), [accounts]);

  const refetchAll = () => { qc.invalidateQueries({ queryKey: ['ledger-accounts'] }); qc.invalidateQueries({ queryKey: ['ledger-vat-codes'] }); qc.invalidateQueries({ queryKey: ['ledger-mappings'] }); };

  const delAccount = useMutationWithToast({
    mutationFn: (id: number) => ledgerService.deleteAccount(id),
    successMessage: t('common.deleted', 'Deleted.'),
    onSuccess: () => refetchAll(),
    errorMessage: (e: any) => e?.response?.data?.error || e.message || 'Failed',
  });
  const setCat = useMutationWithToast({
    mutationFn: ({ id, accId }: { id: number; accId: number | null }) => ledgerService.setCategoryAccount(id, accId),
    invalidateKeys: [['ledger-mappings']],
    errorMessage: (e: any) => e?.response?.data?.error || e.message || 'Failed',
  });
  // Save ONLY the account keys — the VAT maps are owned by VatCodesManager and
  // updateSettings is a partial merge, so scoping the patch here prevents a
  // stale full-settings save from reverting the maps.
  const saveSettings = useMutationWithToast({
    mutationFn: () => {
      const patch: Partial<LedgerSettings> = {};
      for (const k of SETTING_ACCOUNT_KEYS) patch[k] = settings[k];
      return ledgerService.updateSettings(patch);
    },
    successMessage: t('ledger.settingsSaved', 'Mappings saved.'),
    invalidateKeys: [['ledger-mappings']],
    errorMessage: (e: any) => e?.response?.data?.error || e.message || 'Failed',
  });

  const setAcctSetting = (key: keyof LedgerSettings, value: string) => setSettings((s) => ({ ...s, [key]: value }));

  if (la || lm) return <Loading />;

  return (
    <div className="space-y-6">
      <p className="flex items-start gap-2 text-xs text-neutral-500 dark:text-neutral-400">
        <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
        <span>{t('ledger.intro', 'Used only to produce the Treuhänder export — picpeak does not keep double-entry books. The seeded chart + VAT codes follow the Swiss/LI KMU-Kontenrahmen; adjust them to match your Treuhänder’s setup.')}</span>
      </p>

      {/* Default + system accounts */}
      <Card>
        <CardContent className="p-5">
          <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100 mb-3">{t('ledger.defaults.title', 'Default & system accounts')}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {SETTING_ACCOUNT_KEYS.map((key) => (
              <div key={key}>
                <label className={labelCls}>{t(`ledger.defaults.${key}`, key)}</label>
                <select value={settings[key] as string ?? ''} onChange={(e) => setAcctSetting(key, e.target.value)} className={selectCls}>
                  <option value="">{t('ledger.defaults.none', '— none —')}</option>
                  {accountOptions.map((a) => <option key={a.id} value={a.number}>{a.number} · {a.name}</option>)}
                </select>
              </div>
            ))}
          </div>

          <div className="mt-4 flex justify-end">
            <Button onClick={() => saveSettings.mutate()} disabled={saveSettings.isPending}>{saveSettings.isPending ? t('common.saving', 'Saving…') : t('ledger.saveDefaults', 'Save mappings')}</Button>
          </div>
        </CardContent>
      </Card>

      {/* Category → account */}
      <Card>
        <CardContent className="p-5">
          <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100 mb-3">{t('ledger.categoryMap.title', 'Expense category → account')}</h2>
          <div className="space-y-2">
            {(mappings?.categories ?? []).map((c) => (
              <div key={c.id} className="flex items-center gap-3">
                <span className="flex-1 text-sm text-neutral-800 dark:text-neutral-200">{categoryLabel(c as any, t)}</span>
                <select value={c.ledger_account_id ?? ''} onChange={(e) => setCat.mutate({ id: c.id, accId: e.target.value ? Number(e.target.value) : null })} className={selectCls} style={{ maxWidth: 320 }}>
                  <option value="">{t('ledger.defaults.none', '— none —')}</option>
                  {accountOptions.filter((a) => a.type === 'expense').map((a) => <option key={a.id} value={a.id}>{a.number} · {a.name}</option>)}
                </select>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Chart of accounts */}
      <Card>
        <CardContent className="p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">{t('ledger.accounts.title', 'Chart of accounts')}</h2>
            <Button size="sm" onClick={() => setAccountModal({})}><Plus className="w-4 h-4 mr-1" /> {t('ledger.account.addTitle', 'Add account')}</Button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-neutral-500 dark:text-neutral-400 border-b border-neutral-200 dark:border-neutral-700">
                <tr>
                  <th className="py-1.5 pr-3 font-medium">{t('ledger.account.number', 'No.')}</th>
                  <th className="py-1.5 pr-3 font-medium">{t('ledger.account.name', 'Name')}</th>
                  <th className="py-1.5 pr-3 font-medium">{t('ledger.account.type', 'Type')}</th>
                  <th className="py-1.5 pr-3 font-medium text-right">{t('common.actions', 'Actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {(accounts ?? []).map((a) => (
                  <tr key={a.id} className={a.active ? '' : 'opacity-50'}>
                    <td className="py-1.5 pr-3 tabular-nums font-medium text-neutral-900 dark:text-neutral-100">{a.number}</td>
                    <td className="py-1.5 pr-3 text-neutral-800 dark:text-neutral-200">{a.name}</td>
                    <td className="py-1.5 pr-3 text-neutral-500 dark:text-neutral-400">{t(`ledger.accountType.${a.type}`, a.type)}</td>
                    <td className="py-1.5 pr-3">
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={() => setAccountModal({ account: a })} className="p-1 text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"><Pencil className="w-4 h-4" /></button>
                        <button onClick={() => { if (window.confirm(t('ledger.account.confirmDelete', 'Delete this account?') as string)) delAccount.mutate(a.id); }} className="p-1 text-neutral-400 hover:text-red-600"><Trash2 className="w-4 h-4" /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {accountModal && <AccountModal account={accountModal.account} onClose={() => setAccountModal(null)} onDone={() => { setAccountModal(null); refetchAll(); }} />}
    </div>
  );
};

export default ChartOfAccountsManager;
