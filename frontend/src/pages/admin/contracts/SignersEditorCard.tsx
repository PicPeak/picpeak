/**
 * Contract editor → Signers (#1446). Who signs a draft, and in which order.
 *
 * Up to five customer signers, each with their own link; the issuer is added
 * automatically and counter-signs last from the contract page. With no
 * signers set, the contract's customer signs. Saved with its own button
 * (PUT /admin/contracts/:id/signers) — only while the contract is a draft.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { Plus, Save, Trash2 } from 'lucide-react';
import { Button, Card, Loading } from '../../../components/common';
import { PermissionGate } from '../../../components/admin/PermissionGate';
import {
  contractsService,
  type ContractSignersOverview,
  type ContractSigningOrder,
} from '../../../services/contracts.service';

export const MAX_CUSTOMER_SIGNERS = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface SignerRow {
  key: string;
  name: string;
  email: string;
}

const INPUT = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-neutral-900 w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm text-neutral-900 dark:text-neutral-100';

function rowsFrom(overview: ContractSignersOverview): SignerRow[] {
  return overview.signers
    .filter((s) => s.role === 'customer')
    .sort((a, b) => a.position - b.position)
    .map((s) => ({ key: `signer-${s.id}`, name: s.name || '', email: s.email || '' }));
}

interface SignersEditorCardProps {
  contractId: number;
  /** The contract's customer, named in the "signs by default" hint. */
  customerName?: string | null;
}

export const SignersEditorCard: React.FC<SignersEditorCardProps> = ({ contractId, customerName }) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const queryKey = ['contract-signers', contractId];
  const { data, isLoading, isError } = useQuery({
    queryKey,
    queryFn: () => contractsService.signers(contractId),
  });

  const [rows, setRows] = useState<SignerRow[]>([]);
  const [order, setOrder] = useState<ContractSigningOrder>('parallel');
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nextKey = useRef(0);

  // Take the server's list until the admin starts editing.
  useEffect(() => {
    if (!data || dirty) return;
    setRows(rowsFrom(data));
    setOrder(data.order === 'sequential' ? 'sequential' : 'parallel');
  }, [data, dirty]);

  function edit(next: SignerRow[]) {
    setRows(next);
    setDirty(true);
    setError(null);
  }

  function addRow() {
    if (rows.length >= MAX_CUSTOMER_SIGNERS) return;
    nextKey.current += 1;
    edit([...rows, { key: `new-${nextKey.current}`, name: '', email: '' }]);
  }

  function updateRow(key: string, patch: Partial<SignerRow>) {
    edit(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function removeRow(key: string) {
    edit(rows.filter((r) => r.key !== key));
  }

  function validate(): string | null {
    if (rows.length === 0) return t('contracts.signers.errors.none', 'Add at least one signer.');
    const seen = new Set<string>();
    for (let i = 0; i < rows.length; i += 1) {
      const number = i + 1;
      const name = rows[i].name.trim();
      const email = rows[i].email.trim().toLowerCase();
      if (!name) return t('contracts.signers.errors.nameRequired', 'Signer {{number}}: enter a name.', { number });
      if (!EMAIL_RE.test(email)) {
        return t('contracts.signers.errors.emailInvalid', 'Signer {{number}}: enter a valid email address.', { number });
      }
      if (seen.has(email)) {
        return t('contracts.signers.errors.emailDuplicate', 'Signer {{number}}: each signer needs their own email address.', { number });
      }
      seen.add(email);
    }
    return null;
  }

  const saveMutation = useMutation({
    mutationFn: () => contractsService.setSigners(contractId, {
      order,
      signers: rows.map((r) => ({ name: r.name.trim(), email: r.email.trim() })),
    }),
    onSuccess: (overview) => {
      queryClient.setQueryData(queryKey, overview);
      setDirty(false);
      setError(null);
      toast.success(t('contracts.signers.saved', 'Signers saved.') as string);
    },
    onError: (err: unknown) => {
      const response = (err as { response?: { status?: number; data?: { code?: string } } })?.response;
      const code = response?.data?.code;
      if (code === 'CONTRACT_NOT_DRAFT') {
        setError(t('contracts.signers.errors.notDraft', 'The contract has been sent, so its signers can no longer change.'));
      } else if (code === 'SIGNERS_INVALID' || response?.status === 400) {
        setError(t('contracts.signers.errors.invalid', 'Check the names and email addresses: each signer needs a name and their own valid email address.'));
      } else {
        setError(t('contracts.signers.errors.generic', 'The signers couldn\'t be saved. Try again.'));
      }
    },
  });

  function handleSave() {
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    saveMutation.mutate();
  }

  const issuer = data?.signers.find((s) => s.role === 'issuer');
  const issuerName = issuer?.name || t('contracts.signers.issuerYou', 'You (the issuer)');
  const defaultHint = customerName
    ? t('contracts.signers.empty', 'No signers added yet — the contract\'s customer ({{name}}) signs by default.', { name: customerName })
    : t('contracts.signers.emptyNoName', 'No signers added yet — the contract\'s customer signs by default.');

  const issuerRow = (position: number) => (
    <li className="flex flex-wrap items-center gap-2 p-2 rounded border border-dashed border-neutral-300 dark:border-neutral-600 text-sm">
      <span className="w-5 text-neutral-500 dark:text-neutral-400">{position}.</span>
      <span className="font-medium text-neutral-900 dark:text-neutral-100">{issuerName}</span>
      <span className="text-xs text-neutral-500 dark:text-neutral-400">
        {t('contracts.signers.issuerRow', 'Signs last, from this page')}
      </span>
    </li>
  );

  const readOnly = (
    <div className="space-y-3">
      {rows.length === 0 ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">{defaultHint}</p>
      ) : (
        <ol className="space-y-2">
          {rows.map((r, i) => (
            <li key={r.key} className="flex flex-wrap gap-2 text-sm text-neutral-900 dark:text-neutral-100">
              <span className="w-5 text-neutral-500 dark:text-neutral-400">{i + 1}.</span>
              <span className="font-medium">{r.name}</span>
              <span className="text-neutral-600 dark:text-neutral-400">{r.email}</span>
            </li>
          ))}
          {issuerRow(rows.length + 1)}
        </ol>
      )}
    </div>
  );

  return (
    <Card padding="lg" className="mb-3">
      <div className="flex items-center justify-between gap-2 flex-wrap mb-1">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
          {t('contracts.signers.title', 'Signers')}
        </h2>
        {dirty && (
          <span className="text-xs text-amber-700 dark:text-amber-300">
            {t('contracts.signers.unsaved', 'Unsaved changes')}
          </span>
        )}
      </div>
      <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-3">
        {t('contracts.signers.hint', 'Saved separately from the contract. Signers can change until the contract is sent.')}
      </p>

      {isLoading ? (
        <Loading />
      ) : isError ? (
        <p className="text-sm text-red-700 dark:text-red-300">
          {t('contracts.signers.loadError', 'The signers couldn\'t be loaded. Reload the page to try again.')}
        </p>
      ) : (
        <PermissionGate permission="contracts.manage" fallback={readOnly}>
          <div className="space-y-4">
            {rows.length === 0 ? (
              <p className="text-sm text-neutral-600 dark:text-neutral-400">{defaultHint}</p>
            ) : (
              <>
                <ol className="space-y-2">
                  {rows.map((r, i) => (
                    <li key={r.key} className="flex flex-wrap items-center gap-2">
                      <span className="w-5 text-sm text-neutral-500 dark:text-neutral-400">{i + 1}.</span>
                      <div className="flex-1 min-w-[160px]">
                        <input
                          type="text"
                          value={r.name}
                          onChange={(e) => updateRow(r.key, { name: e.target.value })}
                          aria-label={t('contracts.signers.nameOf', 'Name of signer {{number}}', { number: i + 1 })}
                          placeholder={t('contracts.signers.nameLabel', 'Name')}
                          maxLength={255}
                          className={INPUT}
                        />
                      </div>
                      <div className="flex-1 min-w-[200px]">
                        <input
                          type="email"
                          value={r.email}
                          onChange={(e) => updateRow(r.key, { email: e.target.value })}
                          aria-label={t('contracts.signers.emailOf', 'Email of signer {{number}}', { number: i + 1 })}
                          placeholder={t('contracts.signers.emailLabel', 'Email')}
                          maxLength={255}
                          className={INPUT}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => removeRow(r.key)}
                        aria-label={t('contracts.signers.remove', 'Remove signer {{number}}', { number: i + 1 })}
                        className="p-2 rounded-md text-neutral-500 dark:text-neutral-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-neutral-100 dark:hover:bg-neutral-700"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </li>
                  ))}
                  {issuerRow(rows.length + 1)}
                </ol>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  {t('contracts.signers.onlyListedHint', 'Only the people listed here sign. Add the customer too if they should sign.')}
                </p>
              </>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={addRow}
                disabled={rows.length >= MAX_CUSTOMER_SIGNERS}
              >
                <Plus className="w-4 h-4 mr-1" />
                {t('contracts.signers.add', 'Add signer')}
              </Button>
              {rows.length >= MAX_CUSTOMER_SIGNERS && (
                <span className="text-xs text-neutral-500 dark:text-neutral-400">
                  {t('contracts.signers.max', 'You can add up to {{max}} signers.', { max: MAX_CUSTOMER_SIGNERS })}
                </span>
              )}
            </div>

            <fieldset>
              <legend className="text-sm font-medium mb-1 text-neutral-900 dark:text-neutral-100">
                {t('contracts.signers.orderLabel', 'Signing order')}
              </legend>
              <div className="space-y-2">
                {(['parallel', 'sequential'] as const).map((value) => (
                  <label key={value} className="flex items-start gap-2 text-sm text-neutral-800 dark:text-neutral-200">
                    <input
                      type="radio"
                      name={`contract-${contractId}-signing-order`}
                      value={value}
                      checked={order === value}
                      onChange={() => { setOrder(value); setDirty(true); setError(null); }}
                      className="mt-1"
                    />
                    <span>
                      <span className="font-medium">
                        {value === 'parallel'
                          ? t('contracts.signers.orderParallel', 'All at once')
                          : t('contracts.signers.orderSequential', 'One after the other')}
                      </span>
                      <span className="block text-xs text-neutral-500 dark:text-neutral-400">
                        {value === 'parallel'
                          ? t('contracts.signers.orderParallelHint', 'Everyone gets their link when you send the contract.')
                          : t('contracts.signers.orderSequentialHint', 'Signers get their link in the order listed, each once the one before has signed.')}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            {error && (
              <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>
            )}

            <div className="flex justify-end">
              <Button
                onClick={handleSave}
                disabled={!dirty || rows.length === 0 || saveMutation.isPending}
                isLoading={saveMutation.isPending}
              >
                <Save className="w-4 h-4 mr-1" />
                {saveMutation.isPending
                  ? t('contracts.signers.saving', 'Saving…')
                  : t('contracts.signers.save', 'Save signers')}
              </Button>
            </div>
          </div>
        </PermissionGate>
      )}
    </Card>
  );
};
