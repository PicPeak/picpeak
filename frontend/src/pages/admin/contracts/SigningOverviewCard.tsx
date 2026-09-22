/**
 * Contract detail → Signers and signing log (#1446), for contracts sent with
 * signatures v2.
 *
 * - Each signer: status, how they confirmed their identity, when they signed;
 *   "Send the link again" for a customer signer who has a link while the
 *   contract is out for signature (the old link stops working).
 * - The signing log with its chain check (every entry hashes the one before).
 * - "Show evidence": IP address, browser and decline reason, decrypted on
 *   request. Every opening is written to the activity log.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, BellRing, CheckCircle2, Eye, EyeOff, Send, ShieldCheck, Users, XCircle } from 'lucide-react';
import { Button, Card } from '../../../components/common';
import { PermissionGate } from '../../../components/admin/PermissionGate';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';
import { useMutationWithToast } from '../../../hooks';
import {
  contractsService,
  type ContractSigner,
  type ContractSignersOverview,
  type ContractStatus,
} from '../../../services/contracts.service';

const STATUS_CHIP: Record<string, string> = {
  pending: 'bg-neutral-100 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200',
  invited: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  signed: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200',
  declined: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
};

interface SigningOverviewCardProps {
  contractId: number;
  contractStatus: ContractStatus;
  overview: ContractSignersOverview;
}

export const SigningOverviewCard: React.FC<SigningOverviewCardProps> = ({ contractId, contractStatus, overview }) => {
  const { t } = useTranslation();
  const { formatDateTime } = useLocalizedDate();
  const signers = [...overview.signers].sort((a, b) => a.position - b.position);
  const nameOf = (id: number | null) => (id == null ? null : signers.find((s) => s.id === id)?.name || null);

  const resendMutation = useMutationWithToast({
    mutationFn: (signer: ContractSigner) => contractsService.resendSignerLink(contractId, signer.id),
    successMessage: (_data, signer) => t('contracts.signers.resent', 'A new link was sent to {{email}}.', { email: signer.email || '' }) as string,
    invalidateKeys: [['contract-signers', contractId]],
    errorMessage: (err: unknown) => {
      const code = (err as { response?: { data?: { code?: string } } })?.response?.data?.code;
      if (code === 'SIGNER_NOT_DUE') {
        return t('contracts.signers.resendNotDue', 'This signer can\'t get a new link now: it isn\'t their turn yet, or they have already signed.') as string;
      }
      if (code === 'CONTRACT_NOT_SIGNABLE') {
        return t('contracts.signers.resendNotSignable', 'Links can only be sent again while the contract is out for signature.') as string;
      }
      return t('contracts.signers.resendError', 'The link couldn\'t be sent again. Try again.') as string;
    },
  });

  const remindMutation = useMutationWithToast({
    mutationFn: (signer: ContractSigner) => contractsService.remindSigner(contractId, signer.id),
    successMessage: (_data, signer) => t('contracts.signers.reminded', 'A reminder with a new link was sent to {{email}}.', { email: signer.email || '' }) as string,
    invalidateKeys: [['contract-signers', contractId]],
    errorMessage: (err: unknown) => {
      const code = (err as { response?: { data?: { code?: string } } })?.response?.data?.code;
      if (code === 'SIGNER_NOT_DUE') {
        return t('contracts.signers.remindNotDue', 'This signer can\'t be reminded now: it isn\'t their turn yet, or they have already answered.') as string;
      }
      if (code === 'CONTRACT_NOT_SIGNABLE') {
        return t('contracts.signers.resendNotSignable', 'Links can only be sent again while the contract is out for signature.') as string;
      }
      return t('contracts.signers.remindError', 'The reminder couldn\'t be sent. Try again.') as string;
    },
  });

  function statusLabel(s: ContractSigner): string {
    switch (s.status) {
      case 'signed': return t('contracts.signers.status.signed', 'Signed');
      case 'declined': return t('contracts.signers.status.declined', 'Declined');
      case 'invited': return t('contracts.signers.status.invited', 'Link sent');
      default:
        return s.role === 'issuer'
          ? t('contracts.signers.status.issuerPending', 'Counter-signs last')
          : t('contracts.signers.status.pending', 'Not invited yet');
    }
  }

  function viaLabel(via: ContractSigner['verifiedVia']): string | null {
    switch (via) {
      case 'otp': return t('contracts.signers.via.otp', 'Email confirmed with a code');
      case 'portal': return t('contracts.signers.via.portal', 'Signed in to the customer portal');
      case 'admin': return t('contracts.signers.via.admin', 'Counter-signed here');
      default: return null;
    }
  }

  return (
    <>
      <Card padding="lg" className="mb-4">
        <div className="flex items-center justify-between gap-2 flex-wrap mb-1">
          <h2 className="font-semibold flex items-center gap-2 text-neutral-900 dark:text-neutral-100">
            <Users className="w-4 h-4" />
            {t('contracts.signers.title', 'Signers')}
          </h2>
          <span className="text-xs text-neutral-600 dark:text-neutral-400">
            {overview.order === 'sequential'
              ? t('contracts.signers.orderSequential', 'One after the other')
              : t('contracts.signers.orderParallel', 'All at once')}
          </span>
        </div>
        {contractStatus === 'sent' && (
          <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-3">
            {t('contracts.signers.countersignLater', 'You counter-sign here once every customer signer has signed.')}
          </p>
        )}
        {overview.followUp && (
          <div
            role="alert"
            className="mb-3 p-3 rounded-md text-sm border border-amber-300 bg-amber-50 text-amber-900
              dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
          >
            <p className="font-medium flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              {t('contracts.signers.followUpFailed', 'A step after the signature didn\'t go through')}
            </p>
            <p className="mt-1">
              {t(
                'contracts.signers.followUpFailedBody',
                'The signature itself is on record. Since {{date}} one step is still outstanding: {{error}}. Use "Re-send the signed contract" to run it again, or send the next signer their link.',
                { date: formatDateTime(overview.followUp.failedAt), error: overview.followUp.error || '—' },
              )}
            </p>
          </div>
        )}
        <ol className="divide-y divide-neutral-200 dark:divide-neutral-700">
          {signers.map((s) => {
            const via = viaLabel(s.verifiedVia);
            // While details are collected, the first signer's link is the details link.
            const canResend = s.role === 'customer' && s.status === 'invited'
              && (contractStatus === 'sent' || contractStatus === 'awaiting_data');
            return (
              <li key={s.id} className="py-2 flex flex-wrap items-start gap-3 text-sm">
                <span className="w-5 text-neutral-500 dark:text-neutral-400">{s.position}.</span>
                <div className="flex-1 min-w-[180px]">
                  <p className="font-medium text-neutral-900 dark:text-neutral-100">
                    {s.name || '—'}
                    <span className="ml-2 text-xs font-normal text-neutral-500 dark:text-neutral-400">
                      {s.role === 'issuer'
                        ? t('contracts.signers.role.issuer', 'Issuer')
                        : t('contracts.signers.role.customer', 'Customer')}
                    </span>
                  </p>
                  {s.email && <p className="text-xs text-neutral-600 dark:text-neutral-400">{s.email}</p>}
                  <p className="text-xs text-neutral-600 dark:text-neutral-400">
                    {[
                      s.status === 'invited' && s.invitedAt
                        ? t('contracts.signers.invitedAt', 'Link sent {{date}}', { date: formatDateTime(s.invitedAt) })
                        : null,
                      via,
                      s.signedAt ? t('contracts.signers.signedAt', 'Signed {{date}}', { date: formatDateTime(s.signedAt) }) : null,
                      s.signatureMode === 'drawn' ? t('contracts.signers.mode.drawn', 'Drawn signature') : null,
                      s.signatureMode === 'typed' ? t('contracts.signers.mode.typed', 'Typed name') : null,
                      s.declinedAt ? t('contracts.signers.declinedAt', 'Declined {{date}}', { date: formatDateTime(s.declinedAt) }) : null,
                      s.reminderCount && s.remindedAt
                        ? t('contracts.signers.remindedAt', 'Reminded {{count}}×, last {{date}}', { count: s.reminderCount, date: formatDateTime(s.remindedAt) })
                        : null,
                    ].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_CHIP[s.status] || STATUS_CHIP.pending}`}>
                  {statusLabel(s)}
                </span>
                {canResend && (
                  <PermissionGate permission="contracts.manage">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={resendMutation.isPending}
                      onClick={() => {
                        if (window.confirm(t('contracts.signers.resendConfirm', 'Send {{name}} a new signing link? The previous link stops working.', { name: s.name || s.email || '' }) as string)) {
                          resendMutation.mutate(s);
                        }
                      }}
                    >
                      <Send className="w-4 h-4 mr-1" />
                      {t('contracts.signers.resend', 'Send the link again')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={remindMutation.isPending}
                      onClick={() => {
                        if (window.confirm(t('contracts.signers.remindConfirm', 'Send {{name}} a reminder? It carries a new link; the previous one stops working.', { name: s.name || s.email || '' }) as string)) {
                          remindMutation.mutate(s);
                        }
                      }}
                    >
                      <BellRing className="w-4 h-4 mr-1" />
                      {t('contracts.signers.remind', 'Send reminder')}
                    </Button>
                  </PermissionGate>
                )}
              </li>
            );
          })}
        </ol>
        <PermissionGate permission="contracts.manage">
          <EvidencePanel contractId={contractId} />
        </PermissionGate>
      </Card>

      <Card padding="lg" className="mb-4">
        <div className="flex items-center justify-between gap-2 flex-wrap mb-1">
          <h2 className="font-semibold flex items-center gap-2 text-neutral-900 dark:text-neutral-100">
            <ShieldCheck className="w-4 h-4" />
            {t('contracts.signers.log.title', 'Signing log')}
          </h2>
          {overview.chain && (overview.chain.ok ? (
            <span className="inline-flex items-center gap-1 text-xs text-green-700 dark:text-green-300">
              <CheckCircle2 className="w-3.5 h-3.5" />
              {t('contracts.signers.log.chainOk', 'Chain intact')}
              <span className="text-neutral-500 dark:text-neutral-400">
                {' · '}{t('contracts.signers.log.chainCount', 'Entries checked: {{count}}', { count: overview.chain.count })}
              </span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-red-700 dark:text-red-300">
              <XCircle className="w-3.5 h-3.5" />
              {t('contracts.signers.log.chainBroken', 'Chain broken at #{{seq}}', { seq: overview.chain.brokenAt ?? '?' })}
            </span>
          ))}
        </div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-3">
          {t('contracts.signers.log.help', 'Every step of the signing, in order. Each entry is chained to the one before, so a change to any entry shows up in the check.')}
        </p>
        {overview.chain && !overview.chain.ok && overview.chain.reason && (
          <p className="text-sm text-red-700 dark:text-red-300 mb-3">
            {t(`contracts.signers.log.reason.${overview.chain.reason}`, overview.chain.reason)}
          </p>
        )}
        {overview.events.length === 0 ? (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">{t('contracts.signers.log.empty', 'No entries yet.')}</p>
        ) : (
          <ol className="space-y-2">
            {overview.events.map((e) => {
              const actor = e.actorLabel || t(`contracts.signers.log.actor.${e.actorType}`, e.actorType);
              const signer = nameOf(e.signerId);
              return (
                <li key={e.seq} className="flex items-start gap-3 text-sm border-l-2 border-accent-dark pl-3">
                  <span className="font-mono text-xs text-neutral-500 dark:text-neutral-400 w-8 shrink-0">#{e.seq}</span>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-neutral-900 dark:text-neutral-100">
                      {t(`contracts.signers.log.type.${e.type}`, e.type.replace(/_/g, ' '))}
                    </div>
                    <div className="text-xs text-neutral-600 dark:text-neutral-400">
                      {actor}
                      {signer && signer !== e.actorLabel && ` · ${signer}`}
                    </div>
                  </div>
                  <div className="text-xs text-neutral-600 dark:text-neutral-400 whitespace-nowrap font-mono">
                    {formatDateTime(e.occurredAt)}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </Card>
    </>
  );
};

/** Decrypted IP address, browser and decline reason — fetched only on request. */
const EvidencePanel: React.FC<{ contractId: number }> = ({ contractId }) => {
  const { t } = useTranslation();
  const [shown, setShown] = useState(false);
  const { data, isFetching, isError, refetch } = useQuery({
    queryKey: ['contract-signing-evidence', contractId],
    queryFn: () => contractsService.signingEvidence(contractId),
    enabled: false,
    retry: false,
    gcTime: 0,
  });

  const row = (label: string, value: string | null, mono = false) => (
    <>
      <dt className="text-neutral-500 dark:text-neutral-400">{label}</dt>
      <dd className={`text-neutral-900 dark:text-neutral-100 break-all ${mono ? 'font-mono' : ''}`}>{value || '—'}</dd>
    </>
  );

  return (
    <div className="mt-3 pt-3 border-t border-neutral-200 dark:border-neutral-700">
      <div className="flex items-center gap-3 flex-wrap">
        <Button
          variant="outline"
          size="sm"
          disabled={isFetching}
          isLoading={isFetching}
          onClick={() => {
            if (shown) {
              setShown(false);
              return;
            }
            setShown(true);
            refetch();
          }}
        >
          {shown ? <EyeOff className="w-4 h-4 mr-1" /> : <Eye className="w-4 h-4 mr-1" />}
          {shown
            ? t('contracts.signers.evidence.hide', 'Hide evidence')
            : t('contracts.signers.evidence.show', 'Show evidence')}
        </Button>
        <span className="text-xs text-neutral-500 dark:text-neutral-400">
          {t('contracts.signers.evidence.note', 'Shows the IP address, browser and decline reason recorded for each signer. Each time you open it, that is recorded in the activity log.')}
        </span>
      </div>
      {shown && isError && (
        <p className="mt-2 text-sm text-red-700 dark:text-red-300">
          {t('contracts.signers.evidence.error', 'The evidence couldn\'t be loaded. Try again.')}
        </p>
      )}
      {shown && data && (
        <div className="mt-3 space-y-3">
          {data.evidence.length === 0 && (
            <p className="text-sm text-neutral-600 dark:text-neutral-400">{t('contracts.signers.evidence.empty', 'Nothing recorded yet.')}</p>
          )}
          {data.evidence.map((ev) => (
            <div key={ev.signerId} className="p-3 rounded border border-neutral-200 dark:border-neutral-700">
              <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100 mb-1">{ev.name || '—'}</p>
              <dl className="grid grid-cols-1 sm:grid-cols-[12rem_1fr] gap-x-3 gap-y-1 text-xs">
                {row(t('contracts.signers.evidence.ip', 'IP address'), ev.ip, true)}
                {row(t('contracts.signers.evidence.userAgent', 'Browser'), ev.userAgent)}
                {row(t('contracts.signers.evidence.declineReason', 'Decline reason'), ev.declineReason)}
                {row(t('contracts.signers.evidence.signatureSha', 'Signature image SHA-256'), ev.signatureSha256, true)}
                {row(t('contracts.signers.evidence.documentSha', 'Signed document SHA-256'), ev.documentSha256, true)}
              </dl>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
