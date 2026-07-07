/**
 * VAT-codes manager — the single home for VAT codes + the rate→code /
 * treatment→code maps (Settings → Accounting). Relocated from the
 * Chart-of-accounts page so all VAT config lives in one place.
 *
 * NOTE: ledgerService.updateSettings is a PARTIAL merge, so this component saves
 * ONLY the two map keys — the Chart-of-accounts page saves only its account
 * keys, and the two never overwrite each other.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { X, Plus, Pencil, Trash2 } from 'lucide-react';
import { Button, Card, CardContent, Input, Loading } from '../common';
import {
  ledgerService, type LedgerAccount, type VatCode, type VatDirection, type LedgerSettings,
} from '../../services/ledger.service';
import { useMutationWithToast } from '../../hooks';

const labelCls = 'block text-xs font-medium text-neutral-700 dark:text-neutral-300 mb-1';
const selectCls = 'w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-2 text-sm';
const TAX_TREATMENTS = ['domestic', 'reverse_charge_service', 'foreign_vat_non_reclaimable', 'import_goods'];

// Mirror backend ledgerService.rateKey so the map keys we write match the
// lookup at export time (`outputVatMap[rateKey(inv.vat_rate)]`). 8.10 → '8.1',
// 0 → '0', 19 → '19'. Keeping these in sync is what lets a user retype their
// codes to local rates and have the revenue-rate rows follow automatically.
const rateKey = (rate: number | string): string => {
  const n = Number(rate);
  if (!Number.isFinite(n)) return '0';
  return String(Number(n.toFixed(2)));
};

const VatModal: React.FC<{ vat?: VatCode; accounts: LedgerAccount[]; onClose: () => void; onDone: () => void }> = ({ vat, accounts, onClose, onDone }) => {
  const { t } = useTranslation();
  const isEdit = !!vat;
  const [code, setCode] = useState(vat?.code ?? '');
  const [name, setName] = useState(vat?.name ?? '');
  const [rate, setRate] = useState<string>(vat ? String(vat.rate) : '8.1');
  const [direction, setDirection] = useState<VatDirection>(vat?.direction ?? 'input');
  const [accountId, setAccountId] = useState<number | ''>(vat?.account_id ?? '');
  const save = useMutationWithToast({
    mutationFn: () => {
      const payload = { code, name, rate: Number(rate) || 0, direction, accountId: accountId === '' ? null : Number(accountId) };
      return isEdit ? ledgerService.updateVatCode(vat!.id, payload) : ledgerService.createVatCode(payload);
    },
    successMessage: t('common.saved', 'Saved.'),
    onSuccess: () => onDone(),
    errorMessage: (e: any) => e?.response?.data?.error || e.message || 'Failed',
  });
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4">
      <div className="mt-20 w-full max-w-sm rounded-xl bg-white dark:bg-neutral-900 shadow-xl">
        <div className="flex items-center justify-between border-b border-neutral-200 dark:border-neutral-700 px-5 py-3">
          <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">{isEdit ? t('ledger.vat.editTitle', 'Edit VAT code') : t('ledger.vat.addTitle', 'Add VAT code')}</h2>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-600"><X className="w-5 h-5" /></button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div><label className={labelCls}>{t('ledger.vat.code', 'Code')}</label><Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="VST81" /></div>
            <div><label className={labelCls}>{t('ledger.vat.rate', 'Rate %')}</label><Input value={rate} onChange={(e) => setRate(e.target.value)} inputMode="decimal" /></div>
          </div>
          <div><label className={labelCls}>{t('ledger.vat.name', 'Name')}</label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div><label className={labelCls}>{t('ledger.vat.direction', 'Direction')}</label>
            <select value={direction} onChange={(e) => setDirection(e.target.value as VatDirection)} className={selectCls}>
              <option value="input">{t('ledger.vatDirection.input', 'Input (Vorsteuer)')}</option>
              <option value="output">{t('ledger.vatDirection.output', 'Output (Umsatzsteuer)')}</option>
            </select>
          </div>
          <div><label className={labelCls}>{t('ledger.vat.account', 'VAT account')}</label>
            <select value={accountId} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : '')} className={selectCls}>
              <option value="">{t('ledger.vat.noAccount', '— none —')}</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.number} · {a.name}</option>)}
            </select>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-neutral-200 dark:border-neutral-700 px-5 py-3">
          <Button variant="outline" onClick={onClose}>{t('common.cancel', 'Cancel')}</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !code || !name}>{save.isPending ? t('common.saving', 'Saving…') : t('common.save', 'Save')}</Button>
        </div>
      </div>
    </div>
  );
};

export const VatCodesManager: React.FC = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [vatModal, setVatModal] = useState<{ vat?: VatCode } | null>(null);

  const { data: accounts } = useQuery({ queryKey: ['ledger-accounts'], queryFn: () => ledgerService.listAccounts() });
  const { data: vatCodes, isLoading: lv } = useQuery({ queryKey: ['ledger-vat-codes'], queryFn: () => ledgerService.listVatCodes() });
  const { data: mappings, isLoading: lm } = useQuery({ queryKey: ['ledger-mappings'], queryFn: () => ledgerService.getMappings() });

  // Local copy of ONLY the VAT maps (the account keys stay on the CoA page).
  const [maps, setMaps] = useState<Pick<LedgerSettings, 'ledger_vat_map' | 'ledger_output_vat_map'>>({});
  useEffect(() => {
    if (mappings?.settings) {
      setMaps({
        ledger_vat_map: mappings.settings.ledger_vat_map,
        ledger_output_vat_map: mappings.settings.ledger_output_vat_map,
      });
    }
  }, [mappings?.settings]);

  const inputVat = useMemo(() => (vatCodes ?? []).filter((v) => v.direction === 'input'), [vatCodes]);
  const outputVat = useMemo(() => (vatCodes ?? []).filter((v) => v.direction === 'output'), [vatCodes]);

  // Revenue-rate rows are DATA-DRIVEN: the distinct rates of the output codes
  // (first-seen order), not a hardcoded Swiss list. Retype a code to a local
  // rate (e.g. 19) and its row appears here automatically; remove the last code
  // at a rate and that row drops. Seeds (8.1/2.6/3.8/0) just produce the same
  // four rows they did before.
  const outputRates = useMemo(() => {
    const seen = new Set<string>();
    const rates: string[] = [];
    for (const v of outputVat) {
      const k = rateKey(v.rate);
      if (!seen.has(k)) { seen.add(k); rates.push(k); }
    }
    return rates;
  }, [outputVat]);

  const refetch = () => { qc.invalidateQueries({ queryKey: ['ledger-vat-codes'] }); qc.invalidateQueries({ queryKey: ['ledger-mappings'] }); };

  const delVat = useMutationWithToast({
    mutationFn: (id: number) => ledgerService.deleteVatCode(id),
    successMessage: t('common.deleted', 'Deleted.'),
    onSuccess: () => refetch(),
    errorMessage: (e: any) => e?.response?.data?.error || e.message || 'Failed',
  });
  // PARTIAL save — only the two map keys, never the account keys.
  const saveMaps = useMutationWithToast({
    mutationFn: () => ledgerService.updateSettings({
      ledger_vat_map: maps.ledger_vat_map || {},
      ledger_output_vat_map: maps.ledger_output_vat_map || {},
    }),
    successMessage: t('ledger.settingsSaved', 'Mappings saved.'),
    invalidateKeys: [['ledger-mappings']],
    errorMessage: (e: any) => e?.response?.data?.error || e.message || 'Failed',
  });

  const setVatMap = (tt: string, code: string) => setMaps((s) => ({ ...s, ledger_vat_map: { ...(s.ledger_vat_map || {}), [tt]: code } }));
  const setOutputVatMap = (rate: string, code: string) => setMaps((s) => ({ ...s, ledger_output_vat_map: { ...(s.ledger_output_vat_map || {}), [rate]: code } }));

  if (lv || lm) return <Loading />;

  return (
    <div className="space-y-6">
      {/* VAT codes table */}
      <Card><CardContent className="p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">{t('ledger.vatCodes.title', 'VAT codes')}</h2>
          <Button size="sm" onClick={() => setVatModal({})}><Plus className="w-4 h-4 mr-1" /> {t('ledger.vat.addTitle', 'Add VAT code')}</Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-neutral-500 dark:text-neutral-400 border-b border-neutral-200 dark:border-neutral-700">
              <tr>
                <th className="py-1.5 pr-3 font-medium">{t('ledger.vat.code', 'Code')}</th>
                <th className="py-1.5 pr-3 font-medium">{t('ledger.vat.name', 'Name')}</th>
                <th className="py-1.5 pr-3 font-medium text-right">{t('ledger.vat.rate', 'Rate %')}</th>
                <th className="py-1.5 pr-3 font-medium">{t('ledger.vat.direction', 'Direction')}</th>
                <th className="py-1.5 pr-3 font-medium text-right">{t('common.actions', 'Actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {(vatCodes ?? []).map((v) => (
                <tr key={v.id} className={v.active ? '' : 'opacity-50'}>
                  <td className="py-1.5 pr-3 font-medium text-neutral-900 dark:text-neutral-100">{v.code}</td>
                  <td className="py-1.5 pr-3 text-neutral-800 dark:text-neutral-200">{v.name}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-neutral-700 dark:text-neutral-300">{Number(v.rate).toFixed(1)}</td>
                  <td className="py-1.5 pr-3 text-neutral-500 dark:text-neutral-400">{t(`ledger.vatDirection.${v.direction}`, v.direction)}</td>
                  <td className="py-1.5 pr-3">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => setVatModal({ vat: v })} className="p-1 text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"><Pencil className="w-4 h-4" /></button>
                      <button onClick={() => { if (window.confirm(t('ledger.vat.confirmDelete', 'Delete this VAT code?') as string)) delVat.mutate(v.id); }} className="p-1 text-neutral-400 hover:text-red-600"><Trash2 className="w-4 h-4" /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent></Card>

      {/* Rate→code + treatment→code maps */}
      <Card><CardContent className="p-5">
        <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-2">{t('ledger.outputVatMap.title', 'VAT code by revenue rate')}</h3>
        {outputRates.length === 0 ? (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('ledger.outputVatMap.empty', 'Add output VAT codes above to configure a code per revenue rate.')}</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {outputRates.map((rate) => (
              <div key={rate}>
                <label className={labelCls}>{rate}%</label>
                <select value={maps.ledger_output_vat_map?.[rate] ?? ''} onChange={(e) => setOutputVatMap(rate, e.target.value)} className={selectCls}>
                  <option value="">{t('ledger.defaults.none', '— none —')}</option>
                  {outputVat.filter((v) => rateKey(v.rate) === rate).map((v) => <option key={v.id} value={v.code}>{v.code}</option>)}
                </select>
              </div>
            ))}
          </div>
        )}

        <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mt-5 mb-2">{t('ledger.vatMap.title', 'VAT code by tax treatment (costs)')}</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {TAX_TREATMENTS.map((tt) => (
            <div key={tt}>
              <label className={labelCls}>{t(`accounting.taxTreatment.${tt}`, tt)}</label>
              <select value={maps.ledger_vat_map?.[tt] ?? ''} onChange={(e) => setVatMap(tt, e.target.value)} className={selectCls}>
                <option value="">{t('ledger.defaults.none', '— none —')}</option>
                {inputVat.map((v) => <option key={v.id} value={v.code}>{v.code} · {v.name}</option>)}
              </select>
            </div>
          ))}
        </div>

        <div className="mt-4 flex justify-end">
          <Button onClick={() => saveMaps.mutate()} disabled={saveMaps.isPending}>{saveMaps.isPending ? t('common.saving', 'Saving…') : t('ledger.saveDefaults', 'Save mappings')}</Button>
        </div>
      </CardContent></Card>

      {vatModal && <VatModal vat={vatModal.vat} accounts={accounts ?? []} onClose={() => setVatModal(null)} onDone={() => { setVatModal(null); refetch(); }} />}
    </div>
  );
};
