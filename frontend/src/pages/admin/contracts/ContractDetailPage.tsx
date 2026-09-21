/**
 * Admin → Contract detail page.
 *
 * Read-only view for sent / signed / cancelled contracts. Surfaces:
 *   - Status + signing evidence (names, IPs, timestamps)
 *   - PDF download + signed-PDF download (when present)
 *   - "Counter-sign" form when customer has signed
 *   - "Upload signed PDF" file picker (admin path)
 *   - "Send" / "Cancel" buttons for drafts
 *
 * The actual editor lives at /:id/edit and refuses to load when the
 * contract is no longer in draft status.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFeatureFlags } from '../../../contexts/FeatureFlagsContext';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { billsService } from '../../../services/bills.service';
import { quotesService } from '../../../services/quotes.service';
import SignaturePad from 'signature_pad';
import {
  ArrowLeft, Edit2, Send, X, FileDown, Upload, CheckSquare, ScrollText,
  ArrowRightCircle, Receipt, RotateCcw, MailCheck,
  ShieldCheck, CheckCircle2, XCircle,
} from 'lucide-react';
import { Button, Card, Loading } from '../../../components/common';
import { DocumentLineageCard } from '../../../components/admin/DocumentLineageCard';
import {
  contractsService,
  type ContractStatus,
} from '../../../services/contracts.service';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';
import { useMutationWithToast } from '../../../hooks';
import { formatAttachmentSize } from '../../../services/documentAttachments.service';
import { PermissionGate } from '../../../components/admin/PermissionGate';
import { SignaturePadField, type SignaturePadHandle } from '../../../components/contracts/SignaturePadField';
import { SigningOverviewCard } from './SigningOverviewCard';
import { PaperSignatureUploadDialog } from './PaperSignatureUploadDialog';

function statusBadgeClass(status: ContractStatus): string {
  return status === 'fully_signed'         ? 'bg-green-100 text-green-800'
    : status === 'signed_by_customer'      ? 'bg-blue-100 text-blue-800'
    : status === 'signed_by_admin'         ? 'bg-blue-100 text-blue-800'
    : status === 'sent'                    ? 'bg-amber-100 text-amber-800'
    : status === 'declined'                ? 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200'
    : status === 'cancelled'               ? 'bg-neutral-200 text-neutral-600'
    :                                        'bg-neutral-100 text-neutral-700';
}

export const ContractDetailPage: React.FC = () => {
  const { t } = useTranslation();
  // H.5 — gate the "Convert to invoice" action when `bills` is off.
  const { flags } = useFeatureFlags();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // formatDateTime respects the admin-configured `general_date_format`
  // for the date half + 24-hour HH:mm for the time half. The old local
  // wrapper around `format(v, 'PPpp')` ignored the setting and always
  // rendered the date-fns long form ("May 20, 2026 at 14:32").
  const { format, formatDateTime: fmtDateTime } = useLocalizedDate();
  const formatDate = (v: string | null | undefined) => v ? format(v) : '—';
  const formatDateTime = (v: string | null | undefined) => v ? fmtDateTime(v) : '—';
  const numericId = id ? parseInt(id, 10) : null;
  const countersignPadRef = useRef<SignaturePadHandle>(null);

  const [countersignName, setCountersignName] = useState('');
  // Signatures v2: counter-sign with a drawn signature or the typed name.
  const [countersignMode, setCountersignMode] = useState<'drawn' | 'typed'>('drawn');
  const [uploadOpen, setUploadOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['contract', numericId],
    queryFn: () => contractsService.get(numericId as number),
    enabled: numericId !== null,
  });

  // Shares its key with the documents card below, so this costs no extra
  // request — it only decides whether the certificate button is offered.
  const { data: documentsData } = useQuery({
    queryKey: ['contract-documents', numericId],
    queryFn: () => contractsService.documents(numericId as number),
    enabled: numericId !== null,
  });
  const hasCertificate = (documentsData?.documents || []).some((d) => d.kind === 'audit');

  // Lineage: pull the source quote's number AND every invoice whose
  // source_contract_id matches this contract. Both queries are gated
  // off `data` so they only fire after the contract loads. React-Query
  // handles caching so navigating between contract/quote/bill detail
  // pages doesn't refetch.
  const sourceQuoteId = data?.contract?.sourceQuoteId ?? null;
  const { data: sourceQuoteData } = useQuery({
    queryKey: ['quote', sourceQuoteId],
    queryFn: () => quotesService.get(sourceQuoteId as number),
    enabled: !!sourceQuoteId,
  });
  const { data: linkedInvoices } = useQuery({
    queryKey: ['contract-invoices', numericId],
    queryFn: () => billsService.list({ pageSize: 50 } as any),
    enabled: numericId !== null,
    // Filter client-side because the bills endpoint doesn't support
    // sourceContractId yet. The bills list response is capped at 50
    // most-recent — sufficient for contract → invoice flows.
    select: (res) => res?.invoices?.filter((i) => i.sourceContractId === numericId) || [],
  });

  // Signers and the signing log (#1446). `version` tells a signatures-v2
  // contract (one link per signer, signing log) from one sent before, whose
  // cards stay as they were. Until it's known, neither set shows.
  const signersQuery = useQuery({
    queryKey: ['contract-signers', numericId],
    queryFn: () => contractsService.signers(numericId as number),
    enabled: numericId !== null,
  });
  const isV2 = signersQuery.data?.version === 2;
  const legacySigning = signersQuery.isSuccess ? !isV2 : signersQuery.isError;

  const sendMutation = useMutationWithToast({
    mutationFn: () => contractsService.send(numericId as number),
    successMessage: t('contracts.detail.sentToast', 'Contract sent.') as string,
    invalidateKeys: [['contract', numericId], ['contract-signers', numericId]],
    errorMessage: t('contracts.detail.sendError', 'Send failed') as string,
  });

  const cancelMutation = useMutationWithToast({
    mutationFn: () => contractsService.cancel(numericId as number),
    successMessage: t('contracts.detail.cancelledToast', 'Contract cancelled.') as string,
    invalidateKeys: [['contract', numericId], ['contract-signers', numericId]],
    errorMessage: t('contracts.detail.cancelError', 'Cancel failed') as string,
  });

  const countersignMutation = useMutationWithToast({
    mutationFn: () => {
      // Capture the canvas signature (if drawn) at submit time so we
      // send a fresh data URL, not a stale one from an earlier mount.
      const signatureDataUrl = countersignPadRef.current?.toDataUrl() ?? null;
      if (isV2) {
        if (countersignMode === 'drawn' && !signatureDataUrl) {
          throw new Error(t('contracts.detail.countersignDrawRequired', 'Draw your signature, or switch to typing your name.') as string);
        }
        return contractsService.countersign(numericId as number, countersignMode === 'drawn'
          ? { name: countersignName, signatureDataUrl, mode: 'drawn' }
          : { name: countersignName, mode: 'typed' });
      }
      return contractsService.countersign(numericId as number, {
        name: countersignName,
        signatureDataUrl,
      });
    },
    successMessage: t('contracts.detail.countersignedToast', 'Counter-signed.') as string,
    invalidateKeys: [['contract', numericId], ['contract-signers', numericId]],
    errorMessage: (err: any) => {
      if (err?.response?.data?.code === 'CUSTOMERS_PENDING') {
        return t('contracts.detail.countersignCustomersPending', 'Every customer has to sign before you counter-sign.') as string;
      }
      // No HTTP status at all — the connection dropped. The counter-signature
      // may still have been recorded, so don't tell the admin to simply try
      // again on a legally meaningful step (#1446). The refetch below shows
      // where the contract actually stands.
      if (!err?.response) {
        return t('contracts.detail.countersignUncertain',
          'We couldn\'t reach the server, so we can\'t say whether the counter-signature was recorded. The contract has been reloaded — check its status before signing again.') as string;
      }
      return err?.response?.data?.error || err?.message || t('contracts.detail.countersignError', 'Counter-sign failed') as string;
    },
    onError: (err: any) => {
      if (!err?.response && numericId) {
        queryClient.invalidateQueries({ queryKey: ['contract', numericId] });
        queryClient.invalidateQueries({ queryKey: ['contract-signers', numericId] });
      }
    },
    onSuccess: () => {
      setCountersignName('');
      countersignPadRef.current?.clear();
    },
  });

  const uploadMutation = useMutationWithToast({
    mutationFn: ({ file, coversSignerIds }: { file: File; coversSignerIds: number[] }) => (
      contractsService.uploadSignedPdf(numericId as number, file, coversSignerIds)
    ),
    successMessage: t('contracts.detail.uploadedToast', 'Signed PDF uploaded.') as string,
    invalidateKeys: [['contract', numericId], ['contract-signers', numericId], ['contract-paper-coverage', numericId]],
    errorMessage: (err: any) => (err?.response?.data?.code === 'SIGNERS_NOT_COVERED'
      ? t('contracts.paperUpload.notCovered',
        'Confirm every signer the paper copy is signed by — the upload completes the contract for all of them.') as string
      : err?.response?.data?.code === 'ELECTRONIC_SIGNATURE_PRESENT'
        ? t('contracts.paperUpload.refusedBody',
          'At least one signer has already signed this contract in the browser. A paper copy can\'t replace a signature given in the browser, so the upload isn\'t available. Let the remaining signers sign in the browser, then counter-sign on this page.') as string
        : err?.response?.data?.error || t('contracts.detail.uploadError', 'Upload failed') as string),
    onSuccess: () => setUploadOpen(false),
  });

  const resendSignedMutation = useMutationWithToast({
    mutationFn: () => contractsService.resendSigned(numericId as number),
    successMessage: t('contracts.detail.resentSignedToast',
      'Signed contract re-sent to both parties.') as string,
    invalidateKeys: [['contract', numericId]],
    errorMessage: t('contracts.detail.resendError', 'Resend failed') as string,
  });

  const convertToEventMutation = useMutationWithToast({
    mutationFn: () => contractsService.convertToEvent(numericId as number),
    successMessage: (result) => result.alreadyConverted
      ? (t('contracts.detail.alreadyEventToast', 'Already linked to an event.') as string)
      : (t('contracts.detail.convertedToEventToast', 'Contract converted to event #{{id}}', { id: result.eventId }) as string),
    invalidateKeys: [['contract', numericId]],
    errorMessage: t('contracts.detail.convertError', 'Convert failed') as string,
  });

  const convertToInvoiceMutation = useMutationWithToast({
    mutationFn: () => contractsService.convertToInvoice(numericId as number),
    successMessage: (result) => t('contracts.detail.convertedToInvoiceToast',
      '{{count}} invoice(s) created from this contract', { count: result.installmentsCreated }) as string,
    invalidateKeys: [['contract', numericId], ['invoices']],
    errorMessage: t('contracts.detail.convertError', 'Convert failed') as string,
  });

  if (isLoading) return <Loading />;
  if (!data || !data.contract) {
    return (
      <Card padding="lg">
        <p>{t('contracts.detail.notFound', 'Contract not found.')}</p>
      </Card>
    );
  }
  const c = data.contract;

  async function handlePdfDownload() {
    if (!numericId) return;
    // Sync-open BEFORE await so the popup blocker accepts the gesture.
    const previewWindow = window.open('about:blank', '_blank');
    if (!previewWindow) {
      toast.error(t('contracts.detail.popupBlocked', 'Allow pop-ups for this site to preview the PDF.') as string);
      return;
    }
    try {
      const url = await contractsService.pdfUrl(numericId);
      previewWindow.location.href = url;
    } catch (err: any) {
      previewWindow.close();
      toast.error(err?.response?.data?.error || 'PDF unavailable');
    }
  }

  // Pre-send preview: renders a fresh PDF from the current draft without
  // writing/sending anything, so the admin can sanity-check layout +
  // signature blocks before committing to send (no audit trail created).
  async function handlePdfPreview() {
    if (!numericId) return;
    const previewWindow = window.open('about:blank', '_blank');
    if (!previewWindow) {
      toast.error(t('contracts.detail.popupBlocked', 'Allow pop-ups for this site to preview the PDF.') as string);
      return;
    }
    try {
      const url = await contractsService.previewPdfUrl(numericId);
      previewWindow.location.href = url;
    } catch (err: any) {
      previewWindow.close();
      toast.error(err?.response?.data?.error || 'Preview failed');
    }
  }

  async function handleCertificateDownload() {
    if (!numericId) return;
    const previewWindow = window.open('about:blank', '_blank');
    if (!previewWindow) {
      toast.error(t('contracts.detail.popupBlocked', 'Allow pop-ups for this site to preview the PDF.') as string);
      return;
    }
    try {
      previewWindow.location.href = await contractsService.certificateUrl(numericId);
    } catch (err: any) {
      previewWindow.close();
      toast.error(err?.response?.data?.error
        || t('contracts.detail.certificateUnavailable', 'Signing certificate unavailable') as string);
    }
  }

  async function handleSignedPdfDownload() {
    if (!numericId) return;
    const previewWindow = window.open('about:blank', '_blank');
    if (!previewWindow) {
      toast.error(t('contracts.detail.popupBlocked', 'Allow pop-ups for this site to preview the PDF.') as string);
      return;
    }
    try {
      const url = await contractsService.signedPdfUrl(numericId);
      previewWindow.location.href = url;
    } catch (err: any) {
      previewWindow.close();
      toast.error(err?.response?.data?.error || 'Signed PDF unavailable');
    }
  }

  return (
    <div>
      <div className="mb-4 flex items-center gap-3 flex-wrap">
        <Link
          to="/admin/clients/contracts"
          className="inline-flex items-center gap-1 text-sm text-neutral-600 dark:text-neutral-400 hover:text-accent-dark"
        >
          <ArrowLeft className="w-4 h-4" />
          {t('contracts.detail.back', 'Back to list')}
        </Link>
        <h1 className="text-2xl font-bold flex items-center gap-2 flex-1">
          <ScrollText className="w-6 h-6" />
          <span className="font-mono text-base">{c.contractNumber}</span>
          {c.title && <span className="text-base text-neutral-600 dark:text-neutral-400">— {c.title}</span>}
          {c.templateName && (
            <span className="text-xs font-normal text-neutral-600 dark:text-neutral-400">
              {t('contracts.detail.fromTemplate', 'Template: {{name}} · v{{version}}', { name: c.templateName, version: c.templateVersion ?? '' })}
            </span>
          )}
        </h1>
        <span className={`inline-block px-2 py-1 rounded text-xs font-medium ${statusBadgeClass(c.status)}`}>
          {t(`contracts.status.${c.status}`, c.status)}
        </span>
      </div>

      {/* Action bar */}
      <div className="mb-4 flex flex-wrap gap-2">
        {c.status === 'draft' && (
          <>
            <Button variant="outline" onClick={() => navigate(`/admin/clients/contracts/${c.id}/edit`)}>
              <Edit2 className="w-4 h-4 mr-1" />
              {t('contracts.detail.edit', 'Edit')}
            </Button>
            <Button variant="outline" onClick={handlePdfPreview}>
              <FileDown className="w-4 h-4 mr-1" />
              {t('contracts.detail.previewPdf', 'Preview PDF')}
            </Button>
            <Button onClick={() => sendMutation.mutate()} disabled={sendMutation.isPending}>
              <Send className="w-4 h-4 mr-1" />
              {t('contracts.detail.send', 'Send to customer')}
            </Button>
          </>
        )}
        {(c.status === 'draft' || c.status === 'sent') && (
          <Button
            variant="outline"
            onClick={() => {
              if (window.confirm(t('contracts.detail.cancelConfirm', 'Cancel this contract? Customer signing link will be invalidated.') as string)) {
                cancelMutation.mutate();
              }
            }}
            disabled={cancelMutation.isPending}
          >
            <X className="w-4 h-4 mr-1" />
            {t('contracts.detail.cancel', 'Cancel')}
          </Button>
        )}
        {c.pdfPath && (
          <Button variant="outline" onClick={handlePdfDownload}>
            <FileDown className="w-4 h-4 mr-1" />
            {t('contracts.detail.downloadPdf', 'Download PDF')}
          </Button>
        )}
        {c.signedPdfPath && (
          <Button variant="outline" onClick={handleSignedPdfDownload}>
            <FileDown className="w-4 h-4 mr-1" />
            {t('contracts.detail.downloadSignedPdf', 'Download signed PDF')}
          </Button>
        )}
        {/* The signing certificate (#1446) — the evidence record issued at
            completion. It used to leave the server only as an email
            attachment, so a lost email was a lost certificate. */}
        {hasCertificate && (
          <Button variant="outline" onClick={handleCertificateDownload}>
            <FileDown className="w-4 h-4 mr-1" />
            {t('contracts.detail.downloadCertificate', 'Download signing certificate')}
          </Button>
        )}
        {/* Recovery action — on fully-signed contracts, lets the admin
            re-render the signed PDF (if a previous render failed) and
            resend the confirmation email to both parties. Also useful
            when the customer claims they didn't receive it. */}
        {c.status === 'fully_signed' && (
          <Button
            variant="outline"
            onClick={() => {
              if (window.confirm(t('contracts.detail.confirmResendSigned',
                'Re-send the signed contract PDF to both parties?') as string)) {
                resendSignedMutation.mutate();
              }
            }}
            disabled={resendSignedMutation.isPending}
          >
            <MailCheck className="w-4 h-4 mr-1" />
            {t('contracts.detail.resendSigned', 'Re-send signed PDF')}
          </Button>
        )}
        {(c.status === 'sent' || c.status === 'signed_by_customer') && (
          // The upload completes the contract for every signer, so it goes
          // through a dialog that has the admin confirm whose signatures the
          // paper copy carries (#1446).
          <Button
            variant="outline"
            onClick={() => setUploadOpen(true)}
            disabled={uploadMutation.isPending}
          >
            <Upload className="w-4 h-4 mr-1" />
            {t('contracts.detail.uploadSigned', 'Upload signed PDF')}
          </Button>
        )}

        {/* Forward conversions — only available once both parties have
            signed. The two "Convert to ..." buttons replay the source
            quote's installment schedule (so they require a source
            quote OR a standalone-contract path the backend handles).
            Once conversion has happened (event row created OR at least
            one invoice already references this contract) the source
            quote is in 'converted' status and both convert calls would
            error. We swap them for a "New invoice" link that mints an
            ad-hoc invoice — admins commonly want extra invoices on
            top of the scheduled ones (out-of-pocket expenses, change
            requests, etc.). */}
        {c.status === 'fully_signed' && (() => {
          const alreadyConverted = !!c.convertedEventId
            || (Array.isArray(linkedInvoices) && linkedInvoices.length > 0);
          if (alreadyConverted) {
            // fromContractId tells the bill editor to pre-fill customer
            // + event snapshot from the contract AND line items +
            // currency + VAT from the source quote (when present).
            // Mirrors the convertToInvoiceOnly auto-fill but for the
            // ad-hoc "extra invoice" flow.
            // H.5 — gate behind the `bills` flag; without it the
            // /admin/clients/bills/new route is hidden + the button
            // would lead nowhere.
            if (!flags.bills) return null;
            return (
              <Link to={`/admin/clients/bills/new?fromContractId=${c.id}`}>
                <Button variant="outline">
                  <Receipt className="w-4 h-4 mr-1" />
                  {t('contracts.detail.newInvoice', 'New invoice')}
                </Button>
              </Link>
            );
          }
          return (
            <>
              <Button
                onClick={() => {
                  if (window.confirm(t('contracts.detail.confirmConvertEvent',
                    'Convert this contract into an event + scheduled invoices?') as string)) {
                    convertToEventMutation.mutate();
                  }
                }}
                disabled={convertToEventMutation.isPending}
              >
                <ArrowRightCircle className="w-4 h-4 mr-1" />
                {t('contracts.detail.convertToEvent', 'Convert to event')}
              </Button>
              {flags.bills && (
                <Button
                  variant="outline"
                  onClick={() => {
                    if (window.confirm(t('contracts.detail.confirmConvertInvoice',
                      'Convert this contract into invoice(s) only? No gallery / event will be created.') as string)) {
                      convertToInvoiceMutation.mutate();
                    }
                  }}
                  disabled={convertToInvoiceMutation.isPending}
                >
                  <Receipt className="w-4 h-4 mr-1" />
                  {t('contracts.detail.convertToInvoice', 'Convert to invoice only')}
                </Button>
              )}
            </>
          );
        })()}
      </div>

      {/* Migration 136 — recovery banner. The post-sign PDF stamp is
          best-effort (wrapped in try/catch so signature evidence
          persists even when pdf-lib chokes). When the most recent
          attempt failed, signed_pdf_render_failed_at is non-null and
          we surface it here so the admin can hit "Re-send signed PDF"
          (which re-stamps from the immutable pdf_path) without having
          to discover the orphan state via monitoring. */}
      {c.signedPdfRenderFailedAt && (
        <Card padding="lg" className="mb-4 border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950/30">
          <h2 className="font-semibold mb-1 text-red-900 dark:text-red-200">
            {t('contracts.detail.renderFailedTitle',
              'Signed PDF stamp failed — re-stamp required')}
          </h2>
          <p className="text-sm text-red-900 dark:text-red-200">
            {t('contracts.detail.renderFailedBody',
              'The signature evidence is recorded, but the stamped PDF was not generated on the last attempt. Click "Re-send signed PDF" above to re-stamp from the original document and resend.')}
          </p>
          {c.signedPdfRenderError && (
            <p className="mt-2 text-xs font-mono text-red-800 dark:text-red-300 break-words">
              {c.signedPdfRenderError}
            </p>
          )}
        </Card>
      )}

      {/* Recipient + dates */}
      <Card padding="lg" className="mb-4">
        <h2 className="font-semibold mb-2">{t('contracts.detail.parties', 'Parties')}</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-xs uppercase text-neutral-500 dark:text-neutral-400 tracking-wide">
              {t('contracts.detail.customer', 'Customer')}
            </p>
            <p className="font-medium">
              {c.customer.companyName
                || [c.customer.firstName, c.customer.lastName].filter(Boolean).join(' ')
                || c.customer.displayName
                || c.customer.email}
            </p>
            <p className="text-xs text-neutral-600 dark:text-neutral-300">{c.customer.email}</p>
          </div>
          <div>
            <p className="text-xs uppercase text-neutral-500 dark:text-neutral-400 tracking-wide">
              {t('contracts.detail.dates', 'Dates')}
            </p>
            <p className="text-xs">
              <span className="text-neutral-600 dark:text-neutral-300">{t('contracts.detail.issued', 'Issued')}: </span>
              {formatDate(c.issueDate)}
            </p>
            {c.validUntil && (
              <p className="text-xs">
                <span className="text-neutral-600 dark:text-neutral-300">{t('contracts.detail.signBy', 'Sign by')}: </span>
                {formatDate(c.validUntil)}
              </p>
            )}
            {c.sentAt && (
              <p className="text-xs">
                <span className="text-neutral-600 dark:text-neutral-300">{t('contracts.detail.sentAt', 'Sent at')}: </span>
                {formatDateTime(c.sentAt)}
              </p>
            )}
            {/* Inline lineage badges so the linked invoice / source
                quote numbers are visible at-a-glance, matching the
                "From contract" badge layout on BillDetailPage's top
                stats. The full lineage card below still lists all
                linked invoices with status, but the most common
                lookup ("which invoice did this contract become?") now
                surfaces without scrolling. */}
            {sourceQuoteId && (
              <p className="text-xs">
                <span className="text-neutral-600 dark:text-neutral-300">{t('contracts.detail.fromQuote', 'From quote')}: </span>
                <Link
                  to={`/admin/clients/quotes/${sourceQuoteId}`}
                  className="text-accent-dark hover:underline font-mono"
                >
                  {sourceQuoteData?.quote?.quoteNumber || `#${sourceQuoteId}`}
                </Link>
              </p>
            )}
            {linkedInvoices && linkedInvoices.length > 0 && (
              <p className="text-xs">
                <span className="text-neutral-600 dark:text-neutral-300">{t('contracts.detail.linkedInvoice', 'Invoice')}: </span>
                <Link
                  to={`/admin/clients/bills/${linkedInvoices[0].id}`}
                  className="text-accent-dark hover:underline font-mono"
                >
                  {linkedInvoices[0].invoiceNumber}
                </Link>
                {linkedInvoices.length > 1 && (
                  <span className="text-neutral-600 dark:text-neutral-300"> (+{linkedInvoices.length - 1})</span>
                )}
              </p>
            )}
          </div>
        </div>
      </Card>

      {/* Signatures v2: every signer, the signing log, the evidence. */}
      {isV2 && signersQuery.data && numericId !== null && (
        <SigningOverviewCard contractId={numericId} contractStatus={c.status} overview={signersQuery.data} />
      )}

      {/* Signature evidence — contracts sent before v2 (the Signers card
          above covers v2). */}
      {legacySigning && (c.signedByCustomerAt || c.signedByAdminAt) && (
        <Card padding="lg" className="mb-4">
          <h2 className="font-semibold mb-2">{t('contracts.detail.signatures', 'Signatures')}</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <div className="p-3 rounded border border-neutral-200 dark:border-neutral-700">
              <p className="text-xs uppercase text-neutral-500 dark:text-neutral-400 tracking-wide">
                {t('contracts.detail.signedByCustomer', 'Signed by customer')}
              </p>
              {c.signedByCustomerAt ? (
                <>
                  <p className="font-medium">{c.signedCustomerName}</p>
                  <p className="text-xs text-neutral-600 dark:text-neutral-300">{formatDateTime(c.signedByCustomerAt)}</p>
                  {!c.signedCustomerSignaturePath && (
                    <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
                      {t('contracts.detail.noSignatureImage',
                        'No signature image captured — use "Re-stamp signatures" below to add one.')}
                    </p>
                  )}
                </>
              ) : (
                <p className="text-xs text-neutral-600 dark:text-neutral-300">—</p>
              )}
            </div>
            <div className="p-3 rounded border border-neutral-200 dark:border-neutral-700">
              <p className="text-xs uppercase text-neutral-500 dark:text-neutral-400 tracking-wide">
                {t('contracts.detail.signedByAdmin', 'Counter-signed')}
              </p>
              {c.signedByAdminAt ? (
                <>
                  <p className="font-medium">{c.signedAdminName}</p>
                  <p className="text-xs text-neutral-600 dark:text-neutral-300">{formatDateTime(c.signedByAdminAt)}</p>
                  {!c.signedAdminSignaturePath && (
                    <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
                      {t('contracts.detail.noSignatureImage',
                        'No signature image captured — use "Re-stamp signatures" below to add one.')}
                    </p>
                  )}
                </>
              ) : (
                <p className="text-xs text-neutral-600 dark:text-neutral-300">—</p>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* Counter-sign form. Mirrors the public sign page: typed name +
          drawn signature (signature_pad) so the rendered PDF carries
          both signatures, not just typed labels. */}
      {c.status === 'signed_by_customer' && !c.signedByAdminAt && (
        <PermissionGate permission="contracts.manage">
          <CountersignCard
            name={countersignName}
            setName={setCountersignName}
            padRef={countersignPadRef}
            onSubmit={() => countersignMutation.mutate()}
            pending={countersignMutation.isPending}
            modeChoice={isV2 ? { mode: countersignMode, setMode: setCountersignMode } : null}
          />
        </PermissionGate>
      )}

      {/* Re-stamp signatures card. Available on any already-signed
          contract whose customer and/or admin signature image didn't
          capture. Lets the admin draw the missing signature(s) on
          their behalf and re-render the PDF. Names + timestamps + IPs
          stay untouched — this is purely a "the canvas glitched, here
          is the image we should have captured" recovery. */}
      {legacySigning
        && (c.status === 'signed_by_customer' || c.status === 'signed_by_admin' || c.status === 'fully_signed')
        && (!c.signedCustomerSignaturePath || !c.signedAdminSignaturePath) && (
        <RestampSignaturesCard
          contract={c}
          onSuccess={() => queryClient.invalidateQueries({ queryKey: ['contract', numericId] })}
        />
      )}

      {/* Cross-document lineage via deal_uuid (migration 140). Replaces
          the per-FK LinkedDocumentsCard for quotes / contracts /
          invoices / Storni. Events sit outside the deal_uuid group, so
          a converted-event link gets its own small badge below. */}
      <DocumentLineageCard
        dealUuid={c.dealUuid}
        current={{ kind: 'contract', id: c.id }}
        className="mb-4"
      />
      {c.convertedEventId && (
        <Card padding="md" className="mb-4">
          <p className="text-sm">
            <span className="text-neutral-500 dark:text-neutral-400 mr-2">
              {t('contracts.detail.convertedToEvent', 'Converted to event')}:
            </span>
            <Link to={`/admin/events/${c.convertedEventId}`} className="font-medium text-primary-600 dark:text-primary-400 hover:underline">
              #{c.convertedEventId}
            </Link>
          </p>
        </Card>
      )}

      {/* Block summary */}
      <Card padding="lg">
        <h2 className="font-semibold mb-2">{t('contracts.detail.blocks', 'Included blocks')}</h2>
        {c.inclusions && c.inclusions.length > 0 ? (
          <ul className="space-y-1 text-sm">
            {c.inclusions
              .filter((inc) => inc.included)
              .map((inc) => (
                <li key={inc.id} className="flex items-center gap-2">
                  <span className="text-xs uppercase tracking-wide text-neutral-500 w-24">{inc.section}</span>
                  <span>{inc.block?.name || `Block ${inc.blockId}`}</span>
                </li>
              ))}
          </ul>
        ) : (
          <p className="text-sm text-neutral-500">
            {t('contracts.detail.noBlocks', 'No blocks included.')}
          </p>
        )}
      </Card>

      {(c.attachments || []).length > 0 && (
        <Card padding="lg" className="mt-4">
          <h2 className="font-semibold mb-2">{t('contracts.attachments.heading', 'Attachments')}</h2>
          <ul className="space-y-1 text-sm">
            {(c.attachments || []).map((a) => (
              <li key={a.attachmentId} className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-neutral-900 dark:text-neutral-100">{a.name}</span>
                <span className="text-xs text-neutral-500 dark:text-neutral-400">
                  {a.delivery === 'merged'
                    ? t('contracts.attachments.merged', 'In the contract PDF')
                    : t('contracts.attachments.separate', 'Separate file')}
                  {' · '}{t('contracts.attachments.pages', '{{count}} pages', { count: a.pages })} · {formatAttachmentSize(a.bytes)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Audit trail (issue #5 from the maintainer plan) — a
          chronological timeline of every event recorded on this
          contract, sourced from activity_logs. Shows up below the
          included blocks at the bottom of the page so it doesn't
          dominate the layout but is always reachable. */}
      {numericId && <IntegrityCheckCard contractId={numericId} />}
      {numericId && <GeneratedDocumentsCard contractId={numericId} />}
      {numericId && <AuditTrailCard contractId={numericId} />}

      {numericId && (
        <PaperSignatureUploadDialog
          contractId={numericId}
          isOpen={uploadOpen}
          onClose={() => setUploadOpen(false)}
          onUpload={(file, coversSignerIds) => uploadMutation.mutate({ file, coversSignerIds })}
          isUploading={uploadMutation.isPending}
        />
      )}
    </div>
  );
};

/**
 * Re-hashes the unsigned + signed PDFs on disk and compares each to
 * the SHA-256 column persisted at write time (migration 131). The
 * customer already has both expected hashes via the audit-certificate
 * attached to their signing emails; this card is the admin-side
 * equivalent so they don't have to drop to a shell to run
 * `shasum -a 256`.
 *
 * The query is lazy: we don't auto-fire on mount because re-hashing
 * does file I/O on the server, and most page views don't need it.
 * Admin clicks "Verify" to trigger the check.
 */
const IntegrityCheckCard: React.FC<{ contractId: number }> = ({ contractId }) => {
  const { t } = useTranslation();
  const { data, isFetching, refetch, isSuccess, error } = useQuery({
    queryKey: ['contract-integrity', contractId],
    queryFn: () => contractsService.verifyIntegrity(contractId),
    enabled: false,
    retry: false,
    gcTime: 0,
  });

  const renderLeg = (legKey: 'unsigned' | 'signed') => {
    if (!data) return null;
    const leg = data[legKey];
    const titleKey = legKey === 'unsigned'
      ? 'contracts.detail.integrity.unsignedTitle'
      : 'contracts.detail.integrity.signedTitle';
    const titleFallback = legKey === 'unsigned' ? 'Unsigned PDF' : 'Signed PDF';
    let badge: React.ReactNode;
    if (!leg.path) {
      badge = (
        <span className="inline-flex items-center gap-1 text-xs text-neutral-500">
          {t('contracts.detail.integrity.notIssued', 'Not yet issued')}
        </span>
      );
    } else if (!leg.present) {
      badge = (
        <span className="inline-flex items-center gap-1 text-xs text-red-700 dark:text-red-300">
          <XCircle className="w-3.5 h-3.5" />
          {t('contracts.detail.integrity.missing', 'File missing from disk')}
        </span>
      );
    } else if (leg.match) {
      badge = (
        <span className="inline-flex items-center gap-1 text-xs text-green-700 dark:text-green-300">
          <CheckCircle2 className="w-3.5 h-3.5" />
          {t('contracts.detail.integrity.match', 'Hash matches')}
        </span>
      );
    } else {
      badge = (
        <span className="inline-flex items-center gap-1 text-xs text-red-700 dark:text-red-300">
          <XCircle className="w-3.5 h-3.5" />
          {t('contracts.detail.integrity.mismatch', 'Hash mismatch — file altered')}
        </span>
      );
    }
    return (
      <div className="border border-neutral-200 dark:border-neutral-700 rounded p-3 space-y-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">{t(titleKey, titleFallback)}</span>
          {badge}
        </div>
        {leg.path && (
          <p className="text-[11px] text-neutral-500 font-mono break-all" title={leg.path}>
            {leg.path}
          </p>
        )}
        {(leg.expected || leg.actual) && (
          <dl className="grid grid-cols-[6rem_1fr] gap-x-2 gap-y-0.5 text-[11px] font-mono">
            <dt className="text-neutral-500">{t('contracts.detail.integrity.expected', 'expected')}</dt>
            <dd className="break-all">{leg.expected || '—'}</dd>
            <dt className="text-neutral-500">{t('contracts.detail.integrity.actual', 'actual')}</dt>
            <dd className={leg.match ? 'break-all' : 'break-all text-red-700 dark:text-red-300'}>
              {leg.actual || '—'}
            </dd>
          </dl>
        )}
      </div>
    );
  };

  return (
    <Card padding="lg" className="mt-4">
      <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
        <h2 className="font-semibold flex items-center gap-2">
          <ShieldCheck className="w-4 h-4" />
          {t('contracts.detail.integrity.title', 'PDF integrity check')}
        </h2>
        <Button
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          disabled={isFetching}
          isLoading={isFetching}
        >
          {isSuccess
            ? t('contracts.detail.integrity.reverify', 'Re-verify')
            : t('contracts.detail.integrity.verify', 'Verify')}
        </Button>
      </div>
      <p className="text-xs text-neutral-500 mb-3">
        {t('contracts.detail.integrity.help',
          'Re-hashes the unsigned + signed PDFs on disk and compares them to the SHA-256 stored when the document was issued. Catches backup corruption or manual edits since the customer received their copy.')}
      </p>
      {error && (
        <p className="text-sm text-red-700 dark:text-red-300">
          {t('contracts.detail.integrity.error', 'Integrity check failed.')}
        </p>
      )}
      {data && (
        <div className="space-y-2">
          {renderLeg('unsigned')}
          {renderLeg('signed')}
        </div>
      )}
    </Card>
  );
};

/**
 * Chronological audit timeline. Reads activity_logs entries scoped to
 * this contract and renders them as a vertical list with timestamp +
 * actor + a human-readable label per activity_type. Hashes / token
 * fragments etc. are surfaced in monospace so they're auditor-friendly.
 */
/**
 * Every PDF generated for the contract (#1445) — sent for signature,
 * signed, audit certificate — with its checksum, so a copy can be re-hashed
 * and compared.
 */
const GeneratedDocumentsCard: React.FC<{ contractId: number }> = ({ contractId }) => {
  const { t } = useTranslation();
  const { formatDateTime: fmtDateTime } = useLocalizedDate();
  const { data } = useQuery({
    queryKey: ['contract-documents', contractId],
    queryFn: () => contractsService.documents(contractId),
  });
  const documents = data?.documents || [];
  return (
    <Card padding="lg" className="mt-4">
      <h3 className="text-lg font-semibold mb-1">{t('contracts.detail.documents', 'Generated documents')}</h3>
      <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-3">
        {t('contracts.detail.documentsHelp', 'Every PDF made for this contract, with its checksum. Re-hash a copy to confirm it matches.')}
      </p>
      {documents.length === 0 ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">{t('contracts.detail.documentsEmpty', 'No PDFs generated yet.')}</p>
      ) : (
        <ul className="divide-y divide-neutral-200 dark:divide-neutral-700 text-sm">
          {documents.map((d) => (
            <li key={d.id} className="py-2 flex flex-wrap items-center gap-3">
              <span className="font-medium text-neutral-900 dark:text-neutral-100">
                {t(`contracts.detail.documentKind.${d.kind}`, d.kind)}
              </span>
              <span className="text-neutral-600 dark:text-neutral-400">{fmtDateTime(d.generatedAt)}</span>
              {d.pages != null && (
                <span className="text-neutral-600 dark:text-neutral-400">
                  {t('contracts.detail.documentPages', 'Pages: {{count}}', { count: d.pages })}
                </span>
              )}
              <span className="text-neutral-600 dark:text-neutral-400">{Math.max(1, Math.round(d.bytes / 1024))} KB</span>
              <span className="font-mono text-xs text-neutral-500 dark:text-neutral-400 break-all" title={d.sha256}>
                {d.sha256.slice(0, 16)}…
              </span>
              {/* What the PDF was actually made of (#1445): which attachments
                  went into it, in what order, and each one's own checksum —
                  including the ones delivered as separate files, which are
                  bound into nothing else. Recorded at send, but until now
                  unreadable through any API. */}
              {d.manifest?.attachments?.length ? (
                <ul className="w-full mt-1 pl-4 space-y-1 text-xs text-neutral-600 dark:text-neutral-400">
                  {d.manifest.attachments.map((a) => (
                    <li key={a.attachmentId} className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-neutral-700 dark:text-neutral-300">{a.name}</span>
                      <span>
                        {a.delivery === 'merged'
                          ? t('contracts.detail.attachmentMerged', 'merged from page {{page}}', { page: a.firstPage ?? '—' })
                          : t('contracts.detail.attachmentSeparate', 'sent as a separate file')}
                      </span>
                      <span>{t('contracts.detail.documentPages', 'Pages: {{count}}', { count: a.pages })}</span>
                      <span className="font-mono break-all" title={a.sha256}>{a.sha256.slice(0, 12)}…</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
};

const AuditTrailCard: React.FC<{ contractId: number }> = ({ contractId }) => {
  const { t } = useTranslation();
  // formatDateTime honors `general_date_format` + `general_time_format`
  // from admin Settings; previously this card was rendering audit
  // timestamps with a hardcoded `yyyy-MM-dd HH:mm` format that bypassed
  // both. Memory: feedback_respect_general_format_settings.md.
  const { formatDateTime: fmtDateTime } = useLocalizedDate();
  const { data, isLoading } = useQuery({
    queryKey: ['contract-audit-trail', contractId],
    queryFn: () => contractsService.auditTrail(contractId),
  });

  if (isLoading) return null;
  const entries = data?.entries || [];
  if (entries.length === 0) {
    return (
      <Card padding="lg" className="mt-4">
        <h2 className="font-semibold mb-2">
          {t('contracts.detail.auditTrail', 'Audit trail')}
        </h2>
        <p className="text-sm text-neutral-500">
          {t('contracts.detail.auditEmpty', 'No audit-log entries yet.')}
        </p>
      </Card>
    );
  }

  return (
    <Card padding="lg" className="mt-4">
      <h2 className="font-semibold mb-2 flex items-center gap-2">
        <ScrollText className="w-4 h-4" />
        {t('contracts.detail.auditTrail', 'Audit trail')}
      </h2>
      <p className="text-xs text-neutral-500 mb-3">
        {t('contracts.detail.auditTrailHelp',
          'Every event recorded on this contract. The list is append-only and is the source of truth if the contract is challenged.')}
      </p>
      <ol className="space-y-2">
        {entries.map((e) => {
          // Friendly label per activity_type. Falls back to the raw
          // type when an unrecognised entry shows up (forward-
          // compatible — new activity_types just render their key).
          const labelKey = `contracts.audit.${e.activity_type}`;
          const label = t(labelKey, e.activity_type.replace(/^contract_/, '').replace(/_/g, ' '));
          // Compact metadata preview for the right-hand column.
          const meta = e.metadata || {};
          const metaChips = Object.entries(meta)
            .filter(([k]) => k !== 'contractId')
            .slice(0, 3) // cap to avoid wall-of-text on conversion entries
            .map(([k, v]) => {
              // Tokens are 64-char hex — show only the first 8 chars
              // in the UI. Full token is in the DB for forensic
              // correlation; showing it here would just be noise (and
              // a small leak if anyone screenshots the audit timeline
              // before the token is used).
              if (k === 'token' && typeof v === 'string' && v.length >= 16) {
                return `token: ${v.slice(0, 8)}…`;
              }
              return `${k}: ${typeof v === 'string' ? v.slice(0, 24) : v}`;
            });
          return (
            <li key={e.id} className="flex items-start gap-3 text-sm border-l-2 border-accent-dark pl-3">
              <div className="flex-1 min-w-0">
                <div className="font-medium">{label}</div>
                <div className="text-xs text-neutral-500">
                  {e.actor_name || e.actor_type || 'system'}
                  {metaChips.length > 0 && (
                    <span className="ml-2 font-mono">· {metaChips.join(' · ')}</span>
                  )}
                </div>
              </div>
              <div className="text-xs text-neutral-500 whitespace-nowrap font-mono">
                {fmtDateTime(e.created_at)}
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
};

/**
 * Sub-component for the counter-sign card so its useEffect (which
 * needs the canvas to be in the DOM) only runs when the card is
 * actually mounted. Keeps the parent component readable.
 */
interface CountersignProps {
  name: string;
  setName: (v: string) => void;
  padRef: React.RefObject<SignaturePadHandle>;
  onSubmit: () => void;
  pending: boolean;
  /** Signatures v2: a choice between a drawn signature and the typed name. */
  modeChoice?: { mode: 'drawn' | 'typed'; setMode: (mode: 'drawn' | 'typed') => void } | null;
}

const CountersignCard: React.FC<CountersignProps> = ({
  name, setName, padRef, onSubmit, pending, modeChoice,
}) => {
  const { t } = useTranslation();
  const drawn = !modeChoice || modeChoice.mode === 'drawn';

  return (
    <Card padding="lg" className="mb-4">
      <h2 className="font-semibold mb-2">
        {t('contracts.detail.countersignTitle', 'Counter-sign to make it binding')}
      </h2>
      <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-3">
        {modeChoice
          ? t('contracts.detail.countersignHelpV2', 'Every customer has signed. Your signature goes into the issuer\'s field on the PDF, and the signing certificate is issued once you sign.')
          : t('contracts.detail.countersignHelp',
            'Type your name AND draw your signature below — both are stamped onto the re-rendered PDF. IP and timestamp are recorded for audit.')}
      </p>
      <div className="space-y-3">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('contracts.detail.signedNamePlaceholder', 'Your full name') as string}
          className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm"
        />
        {modeChoice && (
          <div role="radiogroup" aria-label={t('contracts.detail.countersignModeLabel', 'How do you want to sign?') as string} className="flex gap-4 text-sm text-neutral-800 dark:text-neutral-200">
            {(['drawn', 'typed'] as const).map((value) => (
              <label key={value} className="inline-flex items-center gap-2">
                <input
                  type="radio"
                  name="countersign-mode"
                  checked={modeChoice.mode === value}
                  onChange={() => modeChoice.setMode(value)}
                />
                {value === 'drawn'
                  ? t('contracts.detail.countersignModeDrawn', 'Draw my signature')
                  : t('contracts.detail.countersignModeTyped', 'Use my typed name')}
              </label>
            ))}
          </div>
        )}
        {drawn ? (
          <div>
            <label className="block text-xs text-neutral-600 dark:text-neutral-400 mb-1">
              {t('contracts.detail.countersignSignaturePrompt', 'Draw your signature')}
            </label>
            <SignaturePadField
              ref={padRef}
              label={t('contracts.detail.countersignSignaturePrompt', 'Draw your signature') as string}
            />
          </div>
        ) : (
          <p className="text-xs text-neutral-600 dark:text-neutral-400">
            {t('contracts.detail.countersignTypedHint', 'Your name, as typed above, is placed in the signature field.')}
          </p>
        )}
        <div className="flex justify-end">
          <Button
            onClick={onSubmit}
            disabled={!name.trim() || pending}
          >
            <CheckSquare className="w-4 h-4 mr-1" />
            {t('contracts.detail.confirmCountersign', 'Counter-sign')}
          </Button>
        </div>
      </div>
    </Card>
  );
};

/**
 * Recovery card: shown when the contract is signed but one or both
 * signature_path columns are null (image didn't capture). Admin draws
 * the missing signature(s); we POST the data URL(s) to the
 * restamp-signatures endpoint which persists the PNG(s), re-renders
 * the PDF, and refreshes signed_pdf_path.
 *
 * Customer's typed name + timestamp + IP stay untouched — only the
 * stamped image changes. The customer DID agree, we're just fixing
 * the artefact.
 */
interface RestampCardProps {
  contract: {
    id: number;
    signedCustomerSignaturePath?: string | null;
    signedAdminSignaturePath?: string | null;
    signedByCustomerAt: string | null;
    signedByAdminAt: string | null;
    signedCustomerName: string | null;
    signedAdminName: string | null;
  };
  onSuccess: () => void;
}

const RestampSignaturesCard: React.FC<RestampCardProps> = ({ contract, onSuccess }) => {
  const { t } = useTranslation();
  const customerCanvasRef = useRef<HTMLCanvasElement>(null);
  const adminCanvasRef = useRef<HTMLCanvasElement>(null);
  const customerPadRef = useRef<SignaturePad | null>(null);
  const adminPadRef = useRef<SignaturePad | null>(null);

  // signature_pad init for both canvases. The two effects intentionally
  // duplicate the HiDPI resize logic — extracting it into a single
  // shared hook would be cleaner but at this size the duplication is
  // less code than the abstraction.
  useEffect(() => {
    function init(ref: React.RefObject<HTMLCanvasElement>, padRefHolder: React.MutableRefObject<SignaturePad | null>) {
      const canvas = ref.current;
      if (!canvas) return () => { /* noop */ };
      const resize = () => {
        const ratio = Math.max(window.devicePixelRatio || 1, 1);
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * ratio;
        canvas.height = rect.height * ratio;
        const ctx = canvas.getContext('2d');
        ctx?.scale(ratio, ratio);
        padRefHolder.current?.clear();
      };
      padRefHolder.current = new SignaturePad(canvas, {
        penColor: '#111',
        backgroundColor: 'rgba(255, 255, 255, 0)',
      });
      resize();
      window.addEventListener('resize', resize);
      return () => {
        window.removeEventListener('resize', resize);
        padRefHolder.current?.off();
        padRefHolder.current = null;
      };
    }
    const cleanupCustomer = init(customerCanvasRef, customerPadRef);
    const cleanupAdmin = init(adminCanvasRef, adminPadRef);
    return () => { cleanupCustomer(); cleanupAdmin(); };
  }, []);

  const mutation = useMutationWithToast({
    mutationFn: () => {
      const customerPad = customerPadRef.current;
      const adminPad = adminPadRef.current;
      const customerSignatureDataUrl = customerPad && !customerPad.isEmpty() ? customerPad.toDataURL('image/png') : null;
      const adminSignatureDataUrl = adminPad && !adminPad.isEmpty() ? adminPad.toDataURL('image/png') : null;
      if (!customerSignatureDataUrl && !adminSignatureDataUrl) {
        throw new Error('Draw at least one signature.');
      }
      return contractsService.restampSignatures(contract.id, {
        customerSignatureDataUrl,
        adminSignatureDataUrl,
      });
    },
    successMessage: t('contracts.detail.restampedToast',
      'Signatures re-stamped and PDF re-rendered.') as string,
    errorMessage: (err: any) => err?.response?.data?.error
      || err?.message
      || t('contracts.detail.restampError', 'Re-stamp failed') as string,
    onSuccess: () => {
      customerPadRef.current?.clear();
      adminPadRef.current?.clear();
      onSuccess();
    },
  });

  const missingCustomer = !contract.signedCustomerSignaturePath && contract.signedByCustomerAt;
  const missingAdmin = !contract.signedAdminSignaturePath && contract.signedByAdminAt;

  return (
    <Card padding="lg" className="mb-4 border-amber-300 dark:border-amber-700">
      <h2 className="font-semibold mb-2">
        {t('contracts.detail.restampTitle', 'Re-stamp missing signatures')}
      </h2>
      <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-3">
        {t('contracts.detail.restampHelp',
          'One or both signatures didn\'t capture an image. Draw the missing signature(s) here and we\'ll re-render the PDF. The typed names, timestamps, and IPs already on file stay untouched.')}
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {missingCustomer && (
          <div>
            <label className="block text-xs text-neutral-600 dark:text-neutral-400 mb-1">
              {t('contracts.detail.restampCustomer', 'Customer signature')}{' '}
              <span className="font-medium">({contract.signedCustomerName})</span>
            </label>
            <canvas
              ref={customerCanvasRef}
              className="w-full h-24 bg-white rounded border border-neutral-300 dark:border-neutral-600 touch-none"
            />
            <button
              type="button"
              onClick={() => customerPadRef.current?.clear()}
              className="mt-1 text-xs text-neutral-600 dark:text-neutral-400 hover:underline inline-flex items-center gap-1"
            >
              <RotateCcw className="w-3 h-3" />
              {t('contracts.detail.clearSignature', 'Clear')}
            </button>
          </div>
        )}
        {missingAdmin && (
          <div>
            <label className="block text-xs text-neutral-600 dark:text-neutral-400 mb-1">
              {t('contracts.detail.restampAdmin', 'Admin signature')}{' '}
              <span className="font-medium">({contract.signedAdminName})</span>
            </label>
            <canvas
              ref={adminCanvasRef}
              className="w-full h-24 bg-white rounded border border-neutral-300 dark:border-neutral-600 touch-none"
            />
            <button
              type="button"
              onClick={() => adminPadRef.current?.clear()}
              className="mt-1 text-xs text-neutral-600 dark:text-neutral-400 hover:underline inline-flex items-center gap-1"
            >
              <RotateCcw className="w-3 h-3" />
              {t('contracts.detail.clearSignature', 'Clear')}
            </button>
          </div>
        )}
      </div>
      <div className="mt-3 flex justify-end">
        <Button
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending}
        >
          <CheckSquare className="w-4 h-4 mr-1" />
          {t('contracts.detail.confirmRestamp', 'Re-stamp & re-render PDF')}
        </Button>
      </div>
    </Card>
  );
};
