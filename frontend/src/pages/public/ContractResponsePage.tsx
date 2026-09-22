/**
 * Public contract signing page (/contract/:token). No login.
 *
 * Signatures v2 (#1446) first: the link is looked up with
 * GET /api/public/contract-signing/invite/:token.
 *   - 404 → a contract sent before v2: the single-link flow below
 *     (LegacyPublicContractResponse), where the customer first confirms a
 *     code emailed to them (upstream #1465) before the contract is shown.
 *   - 410 → the link was replaced, has expired, or the contract was
 *     withdrawn: a message per case.
 *   - otherwise → confirm the email with a code, read the contract, sign
 *     (drawn or typed), or decline. The session is kept in sessionStorage per
 *     link so a reload stays verified until it expires.
 *
 * /contract/signing (ContractSigningSessionPage) runs the same flow from a
 * session the customer portal opened — no link, no code.
 *
 * Visual treatment matches QuoteResponsePage: branding-aware dark/light mode
 * via usePublicDarkMode, issuer logo + name header, neutral card styling.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, CheckCircle, Clock, Download, RotateCcw, ShieldCheck, Upload, XCircle,
} from 'lucide-react';
import SignaturePad from 'signature_pad';
import { Loading } from '../../components/common';
import { usePublicDarkMode } from '../../hooks/usePublicDarkMode';
import { DocumentVerificationStep } from '../../components/public/DocumentVerificationStep';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { SignaturePadField, type SignaturePadHandle } from '../../components/contracts/SignaturePadField';
import { CONTRACT_CARD as CARD, ContractBody, SECTION_LABELS } from '../../components/contracts/ContractBody';
import { OtpVerifyStep } from '../../components/contracts/OtpVerifyStep';
import {
  publicContractsService,
  type PublicContractShell,
  type PublicContractView,
} from '../../services/contracts.service';
import {
  clearDocumentGrant,
  isVerificationRequired,
  readDocumentGrant,
  storeDocumentGrant,
  type DocumentAccessGrant,
  type DocumentVerificationSent,
} from '../../utils/documentAccess';
import {
  PORTAL_SIGNING_SCOPE,
  isSessionInvalid,
  publicContractSigningService,
  saveBlob,
  signingErrorCode,
  signingErrorStatus,
  signingDraftStore,
  signingIdempotencyKey,
  signingSessionStore,
  type SignatureMode,
  type SigningInvite,
  type SigningSession,
  type SigningSessionContract,
} from '../../services/publicContractSigning.service';

const PRIMARY_BUTTON = 'px-4 py-2 rounded-md bg-accent-dark text-white text-sm hover:opacity-90 disabled:opacity-50';
const SECONDARY_BUTTON = 'px-3 py-1.5 rounded-md border border-neutral-300 dark:border-neutral-600 text-sm inline-flex items-center gap-1 disabled:opacity-50 text-neutral-700 dark:text-neutral-300';
const INPUT = 'w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 text-sm text-neutral-900 dark:text-neutral-100';

/** Switch the UI to the contract's language, as QuoteResponsePage does. */
function useContractLanguage(language: string | null | undefined) {
  const { i18n } = useTranslation();
  useEffect(() => {
    if (language && language !== i18n.language) {
      i18n.changeLanguage(language).catch(() => { /* tolerate */ });
    }
  }, [language, i18n]);
}

// ---------------------------------------------------------------------
// Shared layout
// ---------------------------------------------------------------------

/** The issuer header: from the invite summary, or from the full contract view. */
interface IssuerHeader {
  companyName: string | null;
  logoUrl?: string | null;
  logoUrlDark?: string | null;
  website?: string | null;
}

const PageShell: React.FC<{ issuer?: IssuerHeader | null; children: React.ReactNode }> = ({ issuer, children }) => {
  const { isDark } = usePublicDarkMode();
  const logo = isDark
    ? (issuer?.logoUrlDark || issuer?.logoUrl)
    : (issuer?.logoUrl || issuer?.logoUrlDark);
  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100">
      <div className="max-w-3xl mx-auto py-8 px-4">
        {issuer && (
          <div className="text-center mb-6">
            {logo && (
              <img src={logo} alt={issuer.companyName || 'Logo'} className="mx-auto mb-3 h-16 object-contain" />
            )}
            {issuer.companyName && <h2 className="text-xl font-bold">{issuer.companyName}</h2>}
            {issuer.website && (
              <p className="text-sm text-neutral-500 dark:text-neutral-400">{issuer.website}</p>
            )}
          </div>
        )}
        {children}
      </div>
    </div>
  );
};

const FullPageLoading: React.FC = () => (
  <div className="min-h-screen flex items-center justify-center bg-neutral-50 dark:bg-neutral-900">
    <Loading />
  </div>
);

const MessagePage: React.FC<{
  title: string;
  body: string;
  issuer?: IssuerHeader | null;
  action?: React.ReactNode;
}> = ({ title, body, issuer, action }) => (
  <PageShell issuer={issuer}>
    <div className={`${CARD} text-center`}>
      <h1 className="text-2xl font-bold mb-2 text-neutral-900 dark:text-neutral-100">{title}</h1>
      <p className="text-neutral-600 dark:text-neutral-400">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  </PageShell>
);

const LinkGone: React.FC<{ code: string | undefined; issuer?: IssuerHeader | null }> = ({ code, issuer }) => {
  const { t } = useTranslation();
  switch (code) {
    case 'SIGNING_LINK_REVOKED':
      return (
        <MessagePage
          issuer={issuer}
          title={t('contractSigning.gone.revokedTitle', 'This link no longer works')}
          body={t('contractSigning.gone.revokedBody', 'A newer link was sent, or the contract is no longer open for signing. Use the link in the most recent email, or contact the sender.')}
        />
      );
    case 'SIGNING_LINK_EXPIRED':
      return (
        <MessagePage
          issuer={issuer}
          title={t('contractSigning.gone.expiredTitle', 'This link has expired')}
          body={t('contractSigning.gone.expiredBody', 'Ask the sender to send you a new signing link.')}
        />
      );
    case 'CONTRACT_EXPIRED':
      return (
        <MessagePage
          issuer={issuer}
          title={t('contractSigning.gone.contractExpiredTitle', 'The time to sign has run out')}
          body={t('contractSigning.gone.contractExpiredBody', 'This contract can no longer be signed. Ask the sender for a new one if you still want to go ahead.')}
        />
      );
    case 'CONTRACT_WITHDRAWN':
      return (
        <MessagePage
          issuer={issuer}
          title={t('contractSigning.gone.withdrawnTitle', 'This contract has been withdrawn')}
          body={t('contractSigning.gone.withdrawnBody', 'The sender withdrew this contract, so it can no longer be signed. Contact them if you have questions.')}
        />
      );
    default:
      return (
        <MessagePage
          issuer={issuer}
          title={t('publicContract.notFoundTitle', 'Contract not available')}
          body={t('publicContract.notFoundBody', 'This signing link is invalid or expired. Please contact the sender.')}
        />
      );
  }
};

const LoadProblem: React.FC<{ onRetry: () => void; issuer?: IssuerHeader | null }> = ({ onRetry, issuer }) => {
  const { t } = useTranslation();
  return (
    <MessagePage
      issuer={issuer}
      title={t('contractSigning.loadError.title', 'We couldn\'t load this page')}
      body={t('contractSigning.loadError.body', 'Check your connection and try again.')}
      action={(
        <button type="button" onClick={onRetry} className={PRIMARY_BUTTON}>
          {t('contractSigning.loadError.retry', 'Try again')}
        </button>
      )}
    />
  );
};

// ---------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------

export const ContractResponsePage: React.FC = () => {
  const { token } = useParams<{ token: string }>();
  const [linkError, setLinkError] = useState<string | null>(null);

  const inviteQuery = useQuery({
    queryKey: ['contract-signing-invite', token],
    queryFn: () => publicContractSigningService.invite(token as string),
    enabled: !!token,
    retry: false,
  });
  useContractLanguage(inviteQuery.data?.language);

  if (!token) return <LinkGone code={undefined} />;
  if (inviteQuery.isLoading) return <FullPageLoading />;
  if (inviteQuery.isError) {
    const status = signingErrorStatus(inviteQuery.error);
    // Not a v2 link (or not a link we recognise at all): the single-link flow
    // for contracts sent before signatures v2, which also shows "not found".
    if (status === 404 || status === 400) return <LegacyPublicContractResponse />;
    if (status === 410) return <LinkGone code={signingErrorCode(inviteQuery.error)} />;
    return <LoadProblem onRetry={() => { inviteQuery.refetch(); }} />;
  }
  if (!inviteQuery.data) return <LinkGone code={undefined} />;
  if (linkError) return <LinkGone code={linkError} issuer={inviteQuery.data.issuer} />;
  return <SigningFlow scope={token} token={token} invite={inviteQuery.data} onLinkError={setLinkError} />;
};

/** /contract/signing — a session opened from the customer portal. */
export const ContractSigningSessionPage: React.FC = () => {
  const [linkError, setLinkError] = useState<string | null>(null);
  if (linkError) return <LinkGone code={linkError} />;
  return <SigningFlow scope={PORTAL_SIGNING_SCOPE} token={null} invite={null} onLinkError={setLinkError} />;
};

// ---------------------------------------------------------------------
// Signatures v2 flow
// ---------------------------------------------------------------------

interface SigningFlowProps {
  /** Where the session is stored: the link token, or the portal scope. */
  scope: string;
  token: string | null;
  invite: SigningInvite | null;
  onLinkError: (code: string) => void;
}

const SigningFlow: React.FC<SigningFlowProps> = ({ scope, token, invite, onLinkError }) => {
  const { t } = useTranslation();
  const [session, setSession] = useState<SigningSession | null>(() => signingSessionStore.read(scope));
  const [sessionEnded, setSessionEnded] = useState(false);
  const { isDark } = usePublicDarkMode();

  const dropSession = useCallback(() => {
    signingSessionStore.clear(scope);
    setSession(null);
    setSessionEnded(true);
  }, [scope]);

  const viewQuery = useQuery({
    queryKey: ['contract-signing-session', scope, session?.sessionToken],
    queryFn: () => publicContractSigningService.session(session?.sessionToken as string),
    enabled: !!session,
    retry: false,
  });
  useContractLanguage(viewQuery.data?.contract.language);

  useEffect(() => {
    if (!viewQuery.error) return;
    if (isSessionInvalid(viewQuery.error)) {
      dropSession();
      return;
    }
    const code = signingErrorCode(viewQuery.error);
    if (signingErrorStatus(viewQuery.error) === 410 && code) onLinkError(code);
  }, [viewQuery.error, dropSession, onLinkError]);

  function handleVerified(next: SigningSession) {
    signingSessionStore.write(scope, next);
    setSessionEnded(false);
    setSession(next);
  }

  if (!session) {
    if (!token || !invite) {
      return (
        <MessagePage
          title={t('contractSigning.portal.endedTitle', 'Your signing session has ended')}
          body={t('contractSigning.portal.endedBody', 'Open the contract again from your customer portal to continue.')}
          action={(
            <Link to="/customer/contracts" className={`${PRIMARY_BUTTON} inline-block`}>
              {t('contractSigning.portal.backToContracts', 'Go to your contracts')}
            </Link>
          )}
        />
      );
    }
    return (
      <OtpVerifyStep
        token={token}
        maskedEmail={invite.signer.maskedEmail}
        issuer={invite.issuer}
        isDark={isDark}
        notice={sessionEnded
          ? t('contractSigning.sessionEnded', 'Your signing session has ended. Confirm your email again to continue.')
          : null}
        onVerified={handleVerified}
        onLinkError={onLinkError}
      />
    );
  }

  if (viewQuery.isLoading || (viewQuery.isError && isSessionInvalid(viewQuery.error))) return <FullPageLoading />;
  if (viewQuery.isError || !viewQuery.data) {
    return <LoadProblem issuer={invite?.issuer} onRetry={() => { viewQuery.refetch(); }} />;
  }

  // The customer's details come first (#1446): a form, and nothing of the
  // contract until it has been prepared with them.
  if (viewQuery.data.contract.status === 'awaiting_data' && viewQuery.data.contract.dataRequest) {
    return (
      <DetailsForm
        sessionToken={session.sessionToken}
        contract={viewQuery.data.contract}
        onSessionInvalid={dropSession}
        onRefresh={() => viewQuery.refetch()}
      />
    );
  }

  return (
    <SigningContractView
      scope={scope}
      sessionToken={session.sessionToken}
      contract={viewQuery.data.contract}
      onSessionInvalid={dropSession}
      onRefresh={() => viewQuery.refetch()}
    />
  );
};

const DETAIL_LABELS: Record<string, { key: string; fallback: string; autoComplete: string }> = {
  address_line1: { key: 'contractSigning.details.fields.address_line1', fallback: 'Street and number', autoComplete: 'address-line1' },
  address_line2: { key: 'contractSigning.details.fields.address_line2', fallback: 'Address line 2', autoComplete: 'address-line2' },
  postal_code: { key: 'contractSigning.details.fields.postal_code', fallback: 'Postal code', autoComplete: 'postal-code' },
  city: { key: 'contractSigning.details.fields.city', fallback: 'City', autoComplete: 'address-level2' },
  country_code: { key: 'contractSigning.details.fields.country_code', fallback: 'Country (two-letter code, e.g. CH)', autoComplete: 'country' },
  company_name: { key: 'contractSigning.details.fields.company_name', fallback: 'Company', autoComplete: 'organization' },
  vat_id: { key: 'contractSigning.details.fields.vat_id', fallback: 'VAT number', autoComplete: 'off' },
  phone: { key: 'contractSigning.details.fields.phone', fallback: 'Phone', autoComplete: 'tel' },
};

/**
 * Collect-then-freeze (#1446): the first signer completes their details.
 * The contract is prepared with them on submit, and the same session then
 * opens it for review. No contract content is shown here.
 */
const DetailsForm: React.FC<{
  sessionToken: string;
  contract: SigningSessionContract;
  onSessionInvalid: () => void;
  onRefresh: () => Promise<unknown>;
}> = ({ sessionToken, contract: c, onSessionInvalid, onRefresh }) => {
  const { t } = useTranslation();
  const request = c.dataRequest as NonNullable<SigningSessionContract['dataRequest']>;
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...request.values }));
  const [invalid, setInvalid] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(request.submitted);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, [pending]);

  const submit = useMutation({
    mutationFn: () => publicContractSigningService.submitDetails(sessionToken, values),
    onSuccess: async (result) => {
      setError(null);
      if (result.frozen) await onRefresh();
      else setPending(true);
    },
    onError: async (err: unknown) => {
      if (isSessionInvalid(err)) {
        onSessionInvalid();
        return;
      }
      const code = signingErrorCode(err);
      if (code === 'DETAILS_INVALID') {
        const fields = ((err as { response?: { data?: { details?: { fields?: string[] } } } })?.response?.data?.details?.fields) || [];
        setInvalid(fields);
        setError(t('contractSigning.details.invalid', 'Check the highlighted details.'));
        return;
      }
      if (code === 'DATA_ALREADY_SUBMITTED' || code === 'DATA_NOT_REQUESTED') {
        await onRefresh();
        return;
      }
      // No status: we can't say whether it arrived — ask the server.
      if (!signingErrorStatus(err)) {
        await onRefresh();
        setError(t('contractSigning.details.uncertain', 'We couldn\'t confirm that your details arrived. Check the page again before sending them a second time.'));
        return;
      }
      setError(t('contractSigning.details.error', 'Your details couldn\'t be saved. Try again in a moment.'));
    },
  });

  if (pending) {
    return (
      <MessagePage
        issuer={c.issuer}
        title={t('contractSigning.details.savedTitle', 'Your details are saved')}
        body={t('contractSigning.details.savedBody', 'You\'ll receive a new email as soon as the contract is ready.')}
      />
    );
  }

  return (
    <PageShell issuer={c.issuer}>
      <div className={CARD}>
        <h1 ref={heading} tabIndex={-1} className="text-2xl font-bold mb-1 focus:outline-none">
          {t('contractSigning.details.title', 'Your details for contract {{number}}', { number: c.contractNumber })}
        </h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
          {t('contractSigning.details.intro', 'The contract is prepared with these details once you send them; then you can read and sign it right here.')}
        </p>
        <form
          noValidate
          className="grid grid-cols-1 sm:grid-cols-2 gap-3"
          onSubmit={(e) => { e.preventDefault(); setInvalid([]); submit.mutate(); }}
        >
          {request.fields.map((field) => {
            const label = DETAIL_LABELS[field] || { key: field, fallback: field, autoComplete: 'off' };
            const required = request.required.includes(field);
            const bad = invalid.includes(field);
            return (
              <div key={field} className={field === 'address_line1' || field === 'address_line2' ? 'sm:col-span-2' : ''}>
                <label htmlFor={`contract-details-${field}`} className="block text-sm font-medium mb-1">
                  {t(label.key, label.fallback)}
                  {required && <span className="text-neutral-500 dark:text-neutral-400"> {t('contractSigning.consents.required', '(required)')}</span>}
                </label>
                <input
                  id={`contract-details-${field}`}
                  className={`${INPUT} ${bad ? 'border-red-500 dark:border-red-400' : ''}`}
                  value={values[field] || ''}
                  autoComplete={label.autoComplete}
                  required={required}
                  aria-invalid={bad || undefined}
                  onChange={(e) => setValues((cur) => ({ ...cur, [field]: e.target.value }))}
                />
              </div>
            );
          })}
          {error && <p role="alert" className="sm:col-span-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
          <div className="sm:col-span-2 flex justify-end">
            <button type="submit" disabled={submit.isPending} className={PRIMARY_BUTTON}>
              {submit.isPending
                ? t('contractSigning.details.sending', 'Preparing the contract…')
                : t('contractSigning.details.submit', 'Save my details and prepare the contract')}
            </button>
          </div>
        </form>
      </div>
    </PageShell>
  );
};

interface SigningContractViewProps {
  scope: string;
  sessionToken: string;
  contract: SigningSessionContract;
  onSessionInvalid: () => void;
  /** Re-read the session. Awaitable: the sign form asks it whether a
   *  signature whose response was lost actually landed. */
  onRefresh: () => Promise<unknown>;
}

type Outcome =
  | { kind: 'signed'; signedAt: string | null }
  | { kind: 'declined' }
  | { kind: 'uploaded' };

const SigningContractView: React.FC<SigningContractViewProps> = ({
  scope, sessionToken, contract: c, onSessionInvalid, onRefresh,
}) => {
  const { t } = useTranslation();
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  // Reading and signing are two steps (#1446): the contract first, with no
  // input fields, then a compact summary and the signature.
  const [step, setStep] = useState<'review' | 'sign'>('review');
  const [otherOptions, setOtherOptions] = useState(false);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const stepChanged = useRef(false);
  const signing = c.signing;

  // Keyboard and screen-reader users land on the new step's heading.
  useEffect(() => {
    if (!stepChanged.current) return;
    stepHeading.current?.focus();
  }, [step]);
  const goTo = (next: 'review' | 'sign') => {
    stepChanged.current = true;
    setStep(next);
  };

  async function download(key: string, fetcher: () => Promise<Blob>, fileName: string) {
    setDownloading(key);
    setDownloadError(null);
    try {
      saveBlob(await fetcher(), fileName);
    } catch (err) {
      if (isSessionInvalid(err)) {
        onSessionInvalid();
        return;
      }
      setDownloadError(t('contractSigning.documents.downloadError', 'The file couldn\'t be downloaded. Try again in a moment.'));
    } finally {
      setDownloading(null);
    }
  }

  const downloadPdf = () => download(
    'pdf',
    () => publicContractSigningService.pdf(sessionToken),
    `${c.contractNumber}.pdf`,
  );

  // Declining and a wet-signed upload withdraw every session, so their
  // outcome is shown from here rather than re-read from the server.
  const declined = outcome?.kind === 'declined' || signing.status === 'declined';
  const signedByMe = outcome?.kind === 'signed' || signing.status === 'signed';
  const declinedByOther = !declined && c.status === 'declined';
  const signable = signing.canSign && !outcome;

  if (signable && step === 'sign') {
    return (
      <PageShell issuer={c.issuer}>
        <div className={CARD}>
          <h1 ref={stepHeading} tabIndex={-1} className="text-2xl font-bold mb-1 focus:outline-none">
            {t('contractSigning.sign.stepTitle', 'Sign contract no. {{number}}', { number: c.contractNumber })}
          </h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
            {t('contractSigning.sign.stepIntro', 'You are signing exactly the contract you just read. Check the summary, confirm the declarations and sign.')}
          </p>
          <SigningSummary contract={c} />
          <SignForm
            scope={scope}
            sessionToken={sessionToken}
            contract={c}
            onSigned={(signedAt) => { setOutcome({ kind: 'signed', signedAt }); onRefresh(); }}
            onAlreadySigned={onRefresh}
            onSessionInvalid={onSessionInvalid}
            onRefresh={onRefresh}
          />
          <div className="mt-6 pt-4 border-t border-neutral-200 dark:border-neutral-700 flex flex-wrap items-center justify-between gap-2">
            <button type="button" onClick={() => goTo('review')} className={SECONDARY_BUTTON}>
              {t('contractSigning.sign.back', 'Back to the contract')}
            </button>
            {(c.allowPdfUpload || signing.canDecline) && (
              <button
                type="button"
                aria-expanded={otherOptions}
                aria-controls="contract-signing-other-options"
                onClick={() => setOtherOptions((open) => !open)}
                className="text-sm underline text-neutral-700 dark:text-neutral-300"
              >
                {t('contractSigning.sign.otherOptions', 'Other options')}
              </button>
            )}
          </div>
          {otherOptions && (
            <div id="contract-signing-other-options">
              {c.allowPdfUpload && (
                <WetUpload
                  sessionToken={sessionToken}
                  onUploaded={() => setOutcome({ kind: 'uploaded' })}
                  onSessionInvalid={onSessionInvalid}
                />
              )}
              {signing.canDecline && (
                <DeclinePanel
                  sessionToken={sessionToken}
                  onDeclined={() => setOutcome({ kind: 'declined' })}
                  onSessionInvalid={onSessionInvalid}
                  onRefresh={onRefresh}
                />
              )}
            </div>
          )}
        </div>
        <LegalFooter notice={c.legalNotice} />
      </PageShell>
    );
  }

  let action: React.ReactNode;
  if (outcome?.kind === 'uploaded') {
    action = (
      <div className="text-center py-2">
        <CheckCircle className="w-12 h-12 mx-auto text-green-600 dark:text-green-400 mb-3" />
        <h2 className="text-lg font-semibold">{t('contractSigning.upload.doneTitle', 'Thank you — your signed PDF was uploaded.')}</h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
          {t('contractSigning.upload.doneBody', 'You can close this page.')}
        </p>
      </div>
    );
  } else if (declined) {
    action = (
      <div className="text-center py-2">
        <XCircle className="w-12 h-12 mx-auto text-neutral-500 dark:text-neutral-400 mb-3" />
        <h2 className="text-lg font-semibold">{t('contractSigning.declined.title', 'You declined this contract')}</h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
          {t('contractSigning.declined.body', 'The sender has been told. If this was a mistake, contact them — they can send you a new contract.')}
        </p>
      </div>
    );
  } else if (declinedByOther) {
    action = (
      <div className="text-center py-2">
        <XCircle className="w-12 h-12 mx-auto text-neutral-500 dark:text-neutral-400 mb-3" />
        <h2 className="text-lg font-semibold">{t('contractSigning.declined.otherTitle', 'This contract was declined')}</h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
          {t('contractSigning.declined.otherBody', 'Another signer declined it, so it can no longer be signed.')}
        </p>
      </div>
    );
  } else if (signedByMe) {
    action = (
      <SignedResult
        contract={c}
        signedAt={outcome?.kind === 'signed' ? outcome.signedAt : null}
        onDownload={downloadPdf}
        downloading={downloading === 'pdf'}
      />
    );
  } else if (signing.waitingForOthers) {
    action = (
      <div className="flex items-start gap-3">
        <Clock className="w-6 h-6 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
        <div>
          <h2 className="text-lg font-semibold">{t('contractSigning.waiting.title', 'It isn\'t your turn yet')}</h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
            {t('contractSigning.waiting.body', 'The signers before you sign first. We\'ll email you when it\'s your turn.')}
          </p>
        </div>
      </div>
    );
  } else if (signable) {
    action = (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t('contractSigning.review.readyTitle', 'Read everything?')}</h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
            {t('contractSigning.review.readyBody', 'Next you confirm the declarations and sign. Nothing is signed until you press the final button.')}
          </p>
        </div>
        <button type="button" onClick={() => goTo('sign')} className={PRIMARY_BUTTON}>
          {t('contractSigning.review.continue', 'Continue to signing')}
        </button>
      </div>
    );
  } else {
    action = (
      <div>
        <h2 className="text-lg font-semibold">{t('contractSigning.notSignable.title', 'This contract isn\'t waiting for your signature')}</h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
          {t('contractSigning.notSignable.body', 'There is nothing for you to sign right now. Contact the sender if you expected to sign.')}
        </p>
      </div>
    );
  }

  const manifestHash = (attachmentId: number) => c.manifest?.attachments.find((m) => m.attachmentId === attachmentId)?.sha256;

  return (
    <PageShell issuer={c.issuer}>
      {signable && (
        <p ref={stepHeading} tabIndex={-1} className="text-sm font-medium text-neutral-600 dark:text-neutral-400 mb-3 focus:outline-none">
          {t('contractSigning.review.step', 'Step 1 of 2 — read the contract')}
        </p>
      )}
      <ContractBody contract={c} />

      <div className={`mt-6 ${CARD}`}>
        <h2 className="text-lg font-semibold mb-3">{t('contractSigning.documents.title', 'Documents')}</h2>
        <button
          type="button"
          onClick={downloadPdf}
          disabled={downloading === 'pdf'}
          className={SECONDARY_BUTTON}
        >
          <Download className="w-4 h-4" />
          {downloading === 'pdf'
            ? t('contractSigning.documents.downloading', 'Preparing…')
            : t('contractSigning.documents.downloadPdf', 'Download the contract (PDF)')}
        </button>
        {c.attachments.length > 0 && (
          <div className="mt-4">
            <h3 className="text-sm font-semibold mb-2">{t('publicContract.attachments.title', 'Attachments')}</h3>
            <ul className="space-y-2 text-sm">
              {c.attachments.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-3">
                  <span className="font-medium flex-1 min-w-[160px]">
                    {a.name}
                    {manifestHash(a.id) && (
                      <span className="block text-xs font-normal font-mono text-neutral-500 dark:text-neutral-400" title={manifestHash(a.id)}>
                        SHA-256 {manifestHash(a.id)?.slice(0, 16)}…
                      </span>
                    )}
                  </span>
                  {a.delivery === 'separate' ? (
                    <button
                      type="button"
                      onClick={() => download(
                        `attachment-${a.id}`,
                        () => publicContractSigningService.attachment(sessionToken, a.id),
                        `${a.name}.pdf`,
                      )}
                      disabled={downloading === `attachment-${a.id}`}
                      className="inline-flex items-center gap-1 text-sm underline text-neutral-700 dark:text-neutral-300 disabled:opacity-50"
                    >
                      <Download className="w-4 h-4" />
                      {t('publicContract.attachments.download', 'Download')}
                    </button>
                  ) : (
                    <span className="text-xs text-neutral-500 dark:text-neutral-400">
                      {t('publicContract.attachments.inPdf', 'Part of the contract PDF')}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {downloadError && <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">{downloadError}</p>}
      </div>

      <SignerProgress contract={c} />

      <div className={`mt-6 ${CARD}`}>{action}</div>
      <LegalFooter notice={c.legalNotice} />
    </PageShell>
  );
};

/** The legal notice the contract is signed under, as frozen at send (#1446). */
const LegalFooter: React.FC<{ notice?: string | null }> = ({ notice }) => {
  const { t } = useTranslation();
  if (!notice) return null;
  return (
    <footer className="mt-6 text-xs text-neutral-500 dark:text-neutral-400">
      <p className="font-medium">{t('contractSigning.legalNotice.title', 'Legal notice')}</p>
      <p className="whitespace-pre-line">{notice}</p>
    </footer>
  );
};

/** What is about to be signed, in one glance (#1446). */
const SigningSummary: React.FC<{ contract: SigningSessionContract }> = ({ contract: c }) => {
  const { t } = useTranslation();
  const customers = c.signing.signers.filter((s) => s.role === 'customer').map((s) => s.name).filter(Boolean);
  const total = c.commercial ? formatMoneyMinor(c.commercial.totals.grossMinor, c.commercial.currency) : null;
  const row = (label: string, value: React.ReactNode) => (
    <>
      <dt className="text-neutral-500 dark:text-neutral-400">{label}</dt>
      <dd className="text-neutral-900 dark:text-neutral-100 break-words">{value}</dd>
    </>
  );
  return (
    <dl className="grid grid-cols-1 sm:grid-cols-[11rem_1fr] gap-x-3 gap-y-1 text-sm mb-6 p-4 rounded-md bg-neutral-50 dark:bg-neutral-900/40 border border-neutral-200 dark:border-neutral-700">
      {row(t('contractSigning.summary.number', 'Contract'), <span className="font-mono">{c.contractNumber}</span>)}
      {c.title && row(t('contractSigning.summary.title', 'Title'), c.title)}
      {row(t('contractSigning.summary.parties', 'Parties'), [c.issuer?.companyName, ...customers].filter(Boolean).join(' · '))}
      {total && row(t('contractSigning.summary.total', 'Total'), <span className="font-semibold">{total}</span>)}
      {row(t('contractSigning.summary.attachments', 'Attachments'), String(c.manifest ? c.manifest.attachments.length : c.attachments.length))}
      {c.contentSha256 && row(
        t('contractSigning.summary.hash', 'Content fingerprint (SHA-256)'),
        <span className="font-mono text-xs" title={c.contentSha256}>{c.contentSha256.slice(0, 16)}…</span>,
      )}
    </dl>
  );
};

const PROGRESS_CHIP: Record<string, string> = {
  signed: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200',
  declined: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
  pending: 'bg-neutral-100 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200',
};

const SignerProgress: React.FC<{ contract: SigningSessionContract }> = ({ contract: c }) => {
  const { t } = useTranslation();
  const { signers, order } = c.signing;
  if (signers.length === 0) return null;
  const sorted = [...signers].sort((a, b) => a.position - b.position);
  return (
    <div className={`mt-6 ${CARD}`}>
      <h2 className="text-lg font-semibold">{t('contractSigning.signers.title', 'Who signs')}</h2>
      <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-3">
        {order === 'sequential'
          ? t('contractSigning.signers.sequential', 'Signers sign one after the other, in this order.')
          : t('contractSigning.signers.parallel', 'Everyone can sign at the same time.')}
      </p>
      <ol className="space-y-2 text-sm">
        {sorted.map((s) => (
          <li key={s.position} className="flex flex-wrap items-center gap-2">
            <span className="w-5 text-neutral-500 dark:text-neutral-400">{s.position}.</span>
            <span className="font-medium flex-1 min-w-[140px]">
              {s.name}
              {s.role === 'issuer' && (
                <span className="ml-2 text-xs font-normal text-neutral-500 dark:text-neutral-400">
                  {t('contractSigning.signers.issuer', 'Counter-signs last')}
                </span>
              )}
            </span>
            <span className={`px-2 py-0.5 rounded text-xs font-medium ${PROGRESS_CHIP[s.status] || PROGRESS_CHIP.pending}`}>
              {s.status === 'signed'
                ? t('contractSigning.signers.status.signed', 'Signed')
                : s.status === 'declined'
                  ? t('contractSigning.signers.status.declined', 'Declined')
                  : t('contractSigning.signers.status.pending', 'Not signed yet')}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
};

const SignedResult: React.FC<{
  contract: SigningSessionContract;
  signedAt: string | null;
  onDownload: () => void;
  downloading: boolean;
}> = ({ contract: c, signedAt, onDownload, downloading }) => {
  const { t } = useTranslation();
  const { formatDateTime } = useLocalizedDate();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const business = c.issuer?.companyName || t('contractSigning.result.theSender', 'The sender');
  const next = c.status === 'fully_signed'
    ? t('contractSigning.result.complete', 'Everyone has signed — the contract is complete.')
    : c.status === 'signed_by_customer'
      ? t('contractSigning.result.countersignNext', '{{business}} will countersign; you\'ll get the final copy and its signing certificate by email.', { business })
      : t('contractSigning.result.othersPending', 'The contract is complete once everyone has signed. We\'ll email you the final PDF then.');
  const viaPortal = c.signing.verifiedVia === 'portal';
  return (
    <div className="text-center py-2">
      <CheckCircle className="w-12 h-12 mx-auto text-green-600 dark:text-green-400 mb-3" />
      <h2 ref={heading} tabIndex={-1} className="text-lg font-semibold focus:outline-none">
        {t('contractSigning.result.title', 'Thank you — you have signed the contract.')}
      </h2>
      {signedAt && (
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
          {t('contractSigning.result.signedAt', 'Signed on {{date}}', { date: formatDateTime(signedAt) })}
        </p>
      )}
      <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">{next}</p>
      <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
        {t('contractSigning.result.confirmationSent', 'We have sent you a confirmation by email.')}
      </p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        <button type="button" onClick={onDownload} disabled={downloading} className={`${PRIMARY_BUTTON} inline-flex items-center gap-2`}>
          <Download className="w-4 h-4" />
          {t('publicContract.download', 'Download PDF')}
        </button>
        {/* The certificate exists once the contract is complete. Completion
            ends every signing session, so it is downloaded from the portal
            (or arrives by email) rather than from this page. */}
        {viaPortal && (
          <Link to="/customer/contracts" className={`${SECONDARY_BUTTON} inline-flex`}>
            <ShieldCheck className="w-4 h-4" />
            {t('contractSigning.result.portalCertificate', 'Your contracts and certificates')}
          </Link>
        )}
      </div>
    </div>
  );
};

interface SignFormProps {
  scope: string;
  sessionToken: string;
  contract: SigningSessionContract;
  onSigned: (signedAt: string | null) => void;
  onAlreadySigned: () => void;
  onSessionInvalid: () => void;
  /** Re-read the session — used to find out whether a lost signature landed. */
  onRefresh: () => Promise<unknown>;
}

const SignForm: React.FC<SignFormProps> = ({
  scope, sessionToken, contract: c, onSigned, onAlreadySigned, onSessionInvalid, onRefresh,
}) => {
  const { t } = useTranslation();
  const requireDrawn = c.requireDrawnSignature === true;
  const draft = useMemo(() => signingDraftStore.read(scope), [scope]);
  const [name, setName] = useState(draft?.name || c.signing.name || '');
  const [mode, setMode] = useState<SignatureMode>(draft?.mode || 'drawn');
  const [accepted, setAccepted] = useState(false);
  // The declarations frozen at send (#1446), each ticked on its own and
  // never pre-ticked. A contract sent before they existed has none and
  // keeps the single confirmation above.
  const declarations = c.consents && c.consents.length ? c.consents : null;
  const [answers, setAnswers] = useState<Record<string, boolean>>({});
  const missingRequired = declarations ? declarations.filter((d) => d.required && !answers[d.key]) : [];
  const [error, setError] = useState<string | null>(null);
  // A submission whose response never arrived: we cannot say whether it
  // landed, so the page asks the server instead of inviting a blind retry.
  const [uncertain, setUncertain] = useState(false);
  const [checking, setChecking] = useState(false);
  const padRef = useRef<SignaturePadHandle>(null);
  // The drawn image of the attempt in flight, so "Send again" repeats exactly
  // that attempt — under the same idempotency key — even if the pad was
  // cleared meanwhile. In memory only.
  const lastDrawnRef = useRef<string | null>(null);
  const effectiveMode: SignatureMode = requireDrawn ? 'drawn' : mode;

  // Keep what was typed for the tab, so a reload doesn't lose it. Never the
  // drawn image (see signingDraftStore).
  useEffect(() => {
    signingDraftStore.write(scope, { name, mode: effectiveMode });
  }, [scope, name, effectiveMode]);

  function describe(err: unknown): string {
    switch (signingErrorCode(err)) {
      case 'NOT_YOUR_TURN':
        return t('contractSigning.sign.errors.notYourTurn', 'Another signer has to sign first. We\'ll email you when it\'s your turn.');
      case 'CONTRACT_NOT_SIGNABLE':
        return t('contractSigning.sign.errors.notSignable', 'This contract can no longer be signed — it may have been withdrawn or declined. Contact the sender if you have questions.');
      case 'CONTRACT_CHANGED':
        return t('contractSigning.sign.errors.changed', 'This contract changed after it was sent, so it can\'t be signed. Contact the sender.');
      case 'CONTRACT_EXPIRED':
        return t('contractSigning.sign.errors.expired', 'The time to sign this contract has run out. Ask the sender for a new one.');
      case 'SIGNATURE_REQUIRED':
        return requireDrawn
          ? t('publicContract.errorSignatureRequired', 'A drawn signature is required for this contract.')
          : t('contractSigning.sign.errors.drawOrType', 'Draw your signature in the box, or switch to typing your name.');
      case 'SIGNATURE_TOO_LARGE':
        return t('contractSigning.sign.errors.tooLarge', 'Your drawn signature is too large to save. Clear it and draw it again.');
      case 'TOS_REQUIRED':
        return t('publicContract.errorAccept', 'Please tick the acceptance box.');
      case 'CONSENT_REQUIRED':
      case 'CONSENT_UNKNOWN':
        return t('contractSigning.consents.missing', 'Tick every required declaration to sign.');
      case 'NAME_REQUIRED':
        return t('publicContract.errorName', 'Please enter your name.');
      default:
        break;
    }
    if (!signingErrorStatus(err)) {
      return t('contractSigning.otp.errors.network', 'We couldn\'t reach the server. Check your connection and try again.');
    }
    return t('contractSigning.sign.errors.generic', 'Your signature couldn\'t be saved. Try again; if it keeps failing, contact the sender.');
  }

  const signMutation = useMutation({
    mutationFn: (signatureDataUrl: string | null) => publicContractSigningService.sign(sessionToken, {
      name: name.trim(),
      mode: effectiveMode,
      signatureDataUrl: effectiveMode === 'drawn' ? signatureDataUrl : null,
      ...(declarations
        ? { consents: declarations.map((d) => ({ key: d.key, accepted: answers[d.key] === true })) }
        : { accepted: true as const }),
      idempotencyKey: signingIdempotencyKey(scope),
    }),
    onSuccess: (result) => {
      setError(null);
      setUncertain(false);
      signingDraftStore.clear(scope);
      onSigned(result?.signedAt || null);
    },
    onError: async (err: unknown) => {
      if (isSessionInvalid(err)) {
        onSessionInvalid();
        return;
      }
      // Both mean the signature IS on record: the plain repeat, and a key
      // resent with a different name or mode, which the server refuses
      // rather than vouching for a signature nobody made that way (#1446).
      // Either way the honest answer is the recorded signature, not an error.
      if (['ALREADY_SIGNED', 'IDEMPOTENCY_KEY_REUSED'].includes(signingErrorCode(err) || '')) {
        onAlreadySigned();
        return;
      }
      // No HTTP status at all — the connection dropped. The request may
      // still have been recorded, so telling the signer to "try again" is
      // telling them to resubmit something legally meaningful blind. Ask the
      // session which it was: if it landed, the parent swaps this form for
      // the signed result; if it didn't, the panel below offers both a
      // re-check and a deliberate resend under the same idempotency key.
      if (!signingErrorStatus(err)) {
        setError(null);
        setUncertain(true);
        setChecking(true);
        try {
          await onRefresh();
        } finally {
          setChecking(false);
        }
        return;
      }
      setError(describe(err));
    },
  });

  async function checkAgain() {
    setChecking(true);
    try {
      await onRefresh();
    } finally {
      setChecking(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError(t('publicContract.errorName', 'Please enter your name.'));
      return;
    }
    const signatureDataUrl = effectiveMode === 'drawn' ? (padRef.current?.toDataUrl() ?? null) : null;
    lastDrawnRef.current = signatureDataUrl;
    if (effectiveMode === 'drawn' && !signatureDataUrl) {
      setError(requireDrawn
        ? t('publicContract.errorSignatureRequired', 'A drawn signature is required for this contract.')
        : t('contractSigning.sign.errors.drawOrType', 'Draw your signature in the box, or switch to typing your name.'));
      return;
    }
    if (declarations ? missingRequired.length > 0 : !accepted) {
      setError(declarations
        ? t('contractSigning.consents.missing', 'Tick every required declaration to sign.')
        : t('publicContract.errorAccept', 'Please tick the acceptance box.'));
      return;
    }
    setError(null);
    signMutation.mutate(signatureDataUrl);
  }

  const modeButton = (value: SignatureMode, label: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={mode === value}
      onClick={() => { setMode(value); setError(null); }}
      className={`px-3 py-1.5 text-sm rounded-md border ${mode === value
        ? 'border-accent-dark bg-neutral-100 dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100 font-medium'
        : 'border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-300'}`}
    >
      {label}
    </button>
  );

  return (
    <>
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div>
          <label htmlFor="contract-signing-name" className="block text-sm font-medium mb-1">
            {t('publicContract.nameField', 'Your full name')}
          </label>
          <input
            id="contract-signing-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={INPUT}
            autoComplete="name"
          />
        </div>

        {!requireDrawn && (
          <div>
            <p id="contract-signing-mode" className="block text-sm font-medium mb-1">
              {t('contractSigning.sign.modeLabel', 'How do you want to sign?')}
            </p>
            <div role="radiogroup" aria-labelledby="contract-signing-mode" className="flex gap-2">
              {modeButton('drawn', t('contractSigning.sign.modeDrawn', 'Draw'))}
              {modeButton('typed', t('contractSigning.sign.modeTyped', 'Type my name'))}
            </div>
          </div>
        )}

        {effectiveMode === 'drawn' ? (
          <div>
            <p className="block text-sm font-medium mb-1">
              {t('publicContract.signaturePromptRequired', 'Draw your signature')}
            </p>
            <SignaturePadField ref={padRef} label={t('publicContract.signaturePromptRequired', 'Draw your signature')} />
          </div>
        ) : (
          <div>
            <div className="h-20 flex items-center px-4 rounded border border-neutral-300 dark:border-neutral-600 bg-white text-neutral-900 font-serif italic text-2xl overflow-hidden">
              {name.trim()}
            </div>
            <p className="text-xs text-neutral-600 dark:text-neutral-400 mt-1">
              {t('contractSigning.sign.typedHint', 'Your name, as typed above, is placed in your signature field.')}
            </p>
          </div>
        )}

        {declarations ? (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium mb-1">
              {t('contractSigning.consents.legend', 'Your declarations')}
            </legend>
            {declarations.map((d) => (
              <label key={d.key} className="flex items-start gap-2 text-sm text-neutral-700 dark:text-neutral-300">
                <input
                  type="checkbox"
                  checked={answers[d.key] === true}
                  onChange={(e) => setAnswers((cur) => ({ ...cur, [d.key]: e.target.checked }))}
                  aria-required={d.required}
                  className="mt-1"
                />
                <span>
                  {d.text}
                  {' '}
                  <span className="text-xs text-neutral-500 dark:text-neutral-400">
                    {d.required
                      ? t('contractSigning.consents.required', '(required)')
                      : t('contractSigning.consents.optional', '(optional)')}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
        ) : (
          <label className="flex items-start gap-2 text-sm text-neutral-700 dark:text-neutral-300">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
              className="mt-1"
            />
            <span>{t('publicContract.acceptCheckbox', 'I have read this contract and agree to be bound by its terms.')}</span>
          </label>
        )}
        {declarations && missingRequired.length > 0 && (
          <p id="contract-signing-consents-missing" className="text-xs text-neutral-600 dark:text-neutral-400">
            {t('contractSigning.consents.missing', 'Tick every required declaration to sign.')}
          </p>
        )}

        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        {uncertain ? (
          <div
            role="status"
            aria-live="polite"
            className="p-4 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30"
          >
            <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-200 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" />
              {t('contractSigning.sign.uncertain.title', 'We couldn\'t confirm whether your signature arrived')}
            </h3>
            <p className="text-sm text-amber-900 dark:text-amber-200 mt-1">
              {t('contractSigning.sign.uncertain.body',
                'The connection dropped while it was being sent, so it may or may not have been recorded. Check again first. Sending it a second time cannot sign the contract twice — we recognise the repeat.')}
            </p>
            <div className="mt-3 flex flex-wrap gap-2 justify-end">
              <button type="button" onClick={checkAgain} disabled={checking} className={SECONDARY_BUTTON}>
                {checking
                  ? t('contractSigning.sign.uncertain.checking', 'Checking…')
                  : t('contractSigning.sign.uncertain.check', 'Check again')}
              </button>
              <button
                type="button"
                onClick={() => signMutation.mutate(lastDrawnRef.current)}
                disabled={signMutation.isPending || checking}
                className={PRIMARY_BUTTON}
              >
                {signMutation.isPending
                  ? t('contractSigning.sign.submitting', 'Signing…')
                  : t('contractSigning.sign.uncertain.resend', 'Send my signature again')}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={signMutation.isPending || missingRequired.length > 0}
              aria-describedby={missingRequired.length > 0 ? 'contract-signing-consents-missing' : undefined}
              className={PRIMARY_BUTTON}
            >
              {signMutation.isPending
                ? t('contractSigning.sign.submitting', 'Signing…')
                : t('contractSigning.sign.submitBinding', 'Sign contract no. {{number}} bindingly', { number: c.contractNumber })}
            </button>
          </div>
        )}
      </form>
    </>
  );
};

const WetUpload: React.FC<{
  sessionToken: string;
  onUploaded: () => void;
  onSessionInvalid: () => void;
}> = ({ sessionToken, onUploaded, onSessionInvalid }) => {
  const { t } = useTranslation();
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const uploadMutation = useMutation({
    mutationFn: (f: File) => publicContractSigningService.uploadSignedPdf(sessionToken, f),
    onSuccess: () => { setError(null); onUploaded(); },
    onError: (err: unknown) => {
      if (isSessionInvalid(err)) {
        onSessionInvalid();
        return;
      }
      const code = signingErrorCode(err);
      setError(code === 'UPLOAD_DISABLED'
        ? t('contractSigning.upload.errors.disabled', 'Uploading a signed PDF is switched off for this contract. Please sign in your browser instead.')
        : code === 'CONTRACT_NOT_SIGNABLE'
          ? t('contractSigning.sign.errors.notSignable', 'This contract can no longer be signed — it may have been withdrawn or declined. Contact the sender if you have questions.')
          : t('contractSigning.upload.errors.generic', 'The upload failed. Make sure the file is a PDF under 10 MB, then try again.'));
    },
  });
  return (
    <div className="mt-6 pt-4 border-t border-neutral-200 dark:border-neutral-700">
      <h3 className="text-sm font-semibold mb-2">{t('publicContract.uploadAlternative', 'Or upload a wet-signed PDF')}</h3>
      <p className="text-xs text-neutral-600 dark:text-neutral-400 mb-2">
        {t('publicContract.uploadHint', 'Sign the printed contract by hand, scan it, and upload the PDF here.')}
      </p>
      <div className="flex items-center gap-2 flex-wrap">
        <input
          type="file"
          accept="application/pdf"
          onChange={(e) => setFile(e.target.files?.[0] || null)}
          className="text-sm text-neutral-700 dark:text-neutral-300"
        />
        <button
          type="button"
          disabled={!file || uploadMutation.isPending}
          onClick={() => file && uploadMutation.mutate(file)}
          className={SECONDARY_BUTTON}
        >
          <Upload className="w-4 h-4" />
          {t('publicContract.uploadButton', 'Upload signed PDF')}
        </button>
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
};

const DeclinePanel: React.FC<{
  sessionToken: string;
  onDeclined: () => void;
  onSessionInvalid: () => void;
  onRefresh: () => Promise<unknown>;
}> = ({ sessionToken, onDeclined, onSessionInvalid, onRefresh }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const declineMutation = useMutation({
    mutationFn: () => publicContractSigningService.decline(sessionToken, reason.trim() || undefined),
    onSuccess: () => { setError(null); onDeclined(); },
    onError: async (err: unknown) => {
      if (isSessionInvalid(err)) {
        onSessionInvalid();
        return;
      }
      if (signingErrorCode(err) === 'CONTRACT_NOT_SIGNABLE') {
        setError(t('contractSigning.sign.errors.notSignable', 'This contract can no longer be signed — it may have been withdrawn or declined. Contact the sender if you have questions.'));
        return;
      }
      // No HTTP status: the connection dropped and we cannot say whether the
      // refusal was recorded. Re-read the contract rather than leaving the
      // signer to guess — declining is not something to repeat blindly.
      if (!signingErrorStatus(err)) {
        setError(t('contractSigning.decline.uncertain',
          'We couldn\'t reach the server, so we can\'t say whether your refusal was recorded. Reload this page to see where the contract stands before trying again.'));
        await onRefresh();
        return;
      }
      setError(t('contractSigning.decline.error', 'The contract couldn\'t be declined. Try again; if it keeps failing, contact the sender.'));
    },
  });

  if (!open) {
    return (
      <div className="mt-6 pt-4 border-t border-neutral-200 dark:border-neutral-700">
        <button type="button" onClick={() => setOpen(true)} className="text-sm underline text-neutral-700 dark:text-neutral-300">
          {t('contractSigning.decline.open', 'Decline the contract')}
        </button>
      </div>
    );
  }

  return (
    <div className="mt-6 pt-4 border-t border-neutral-200 dark:border-neutral-700">
      <div className="p-4 rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30">
        <h3 className="text-sm font-semibold text-red-900 dark:text-red-200 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" />
          {t('contractSigning.decline.confirmTitle', 'Decline this contract?')}
        </h3>
        <p className="text-sm text-red-900 dark:text-red-200 mt-1">
          {t('contractSigning.decline.confirmBody', 'The sender is told that you declined, and nobody can sign this contract any more. This can\'t be undone.')}
        </p>
        <label htmlFor="contract-decline-reason" className="block text-sm font-medium mt-3 mb-1 text-neutral-900 dark:text-neutral-100">
          {t('contractSigning.decline.reasonLabel', 'Reason (optional)')}
        </label>
        <textarea
          id="contract-decline-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value.slice(0, 1000))}
          rows={3}
          className={INPUT}
        />
        <p className="text-xs text-neutral-600 dark:text-neutral-400 mt-1">
          {t('contractSigning.decline.reasonHint', 'Shared with the sender.')}
        </p>
        {error && <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">{error}</p>}
        <div className="mt-3 flex flex-wrap gap-2 justify-end">
          <button type="button" onClick={() => { setOpen(false); setError(null); }} className={SECONDARY_BUTTON}>
            {t('contractSigning.decline.keep', 'Keep the contract')}
          </button>
          <button
            type="button"
            onClick={() => declineMutation.mutate()}
            disabled={declineMutation.isPending}
            className="px-3 py-1.5 rounded-md text-sm bg-red-600 hover:bg-red-700 text-white disabled:opacity-50"
          >
            {declineMutation.isPending
              ? t('contractSigning.decline.declining', 'Declining…')
              : t('contractSigning.decline.confirm', 'Decline contract')}
          </button>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------
// Contracts sent before signatures v2: one link, no code.
// ---------------------------------------------------------------------

/**
 * Maximum width of the exported signature PNG. The on-screen canvas
 * uses CSS-pixel size × devicePixelRatio for crisp strokes; without
 * downscaling, a 4× retina display exports a multi-MB PNG that
 * trips the server's SIGNATURE_TOO_LARGE cap (1 MB base64). 800 px
 * is wide enough to render the signature legibly when stamped onto
 * the contract PDF (printed at 4 inches × 200 dpi).
 */
const MAX_SIGNATURE_WIDTH = 800;

/**
 * Export the signature canvas as a downscaled PNG data URL.
 * Renders the source canvas onto a temporary canvas at
 * MAX_SIGNATURE_WIDTH (preserving aspect ratio), then exports via
 * toDataURL. The pad parameter is passed for the empty-state check
 * + the fallback path when downscaling can't run.
 */
function downscaleSignature(pad: SignaturePad, sourceCanvas: HTMLCanvasElement): string {
  const srcW = sourceCanvas.width;
  const srcH = sourceCanvas.height;
  if (srcW <= MAX_SIGNATURE_WIDTH) {
    return pad.toDataURL('image/png');
  }
  const scale = MAX_SIGNATURE_WIDTH / srcW;
  const targetW = MAX_SIGNATURE_WIDTH;
  const targetH = Math.round(srcH * scale);
  const dst = document.createElement('canvas');
  dst.width = targetW;
  dst.height = targetH;
  const ctx = dst.getContext('2d');
  if (!ctx) return pad.toDataURL('image/png');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(sourceCanvas, 0, 0, srcW, srcH, 0, 0, targetW, targetH);
  return dst.toDataURL('image/png');
}

export interface ContractSignPayload {
  name: string;
  signatureDataUrl: string | null;
  accepted: true;
}

/** Where the view reads and writes its contract: a public link or the portal. */
export interface ContractDocumentAdapter {
  /** Query key for the contract; must change when access changes. */
  queryKey: readonly unknown[];
  load: () => Promise<{ contract: PublicContractView | PublicContractShell }>;
  sign: (payload: ContractSignPayload) => Promise<unknown>;
  uploadSignedPdf: (file: File) => Promise<unknown>;
  /** Blob URL of the most authoritative PDF. */
  pdfUrl: () => Promise<string>;
  /** Public links only: email a code, exchange it for a grant, drop the grant. */
  verification?: {
    requestCode: () => Promise<DocumentVerificationSent>;
    confirmCode: (code: string) => Promise<DocumentAccessGrant>;
    onVerified: (access: DocumentAccessGrant) => void;
    onAccessLost: () => void;
  };
}

const isShell = (c: PublicContractView | PublicContractShell): c is PublicContractShell =>
  c.verificationRequired === true;

export const ContractResponseView: React.FC<{ adapter: ContractDocumentAdapter }> = ({ adapter }) => {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  // Honour branding dark/light mode the same way QuoteResponsePage
  // does — without this the page renders in light regardless of admin
  // settings. The wrapper styling below still has `dark:` variants
  // so the page reads cleanly in either mode. `isDark` drives the
  // theme-aware logo pick in the header.
  const { isDark } = usePublicDarkMode();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const padRef = useRef<SignaturePad | null>(null);

  // Form state lives here, above the verification branch, so a grant that
  // runs out mid-visit sends the customer back to the code step without
  // throwing away what they typed.
  const [name, setName] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [verificationNotice, setVerificationNotice] = useState<string | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: adapter.queryKey,
    queryFn: adapter.load,
    retry: false,
  });

  const contract = data && !isShell(data.contract) ? data.contract : null;

  // Switch UI locale to the contract's language for a consistent
  // customer experience (matches QuoteResponsePage).
  useEffect(() => {
    if (data?.contract.language && data.contract.language !== i18n.language) {
      i18n.changeLanguage(data.contract.language).catch(() => { /* tolerate */ });
    }
  }, [data, i18n]);

  // Initialise signature_pad once the canvas is mounted. Re-sizes the
  // canvas drawing buffer to its CSS dimensions × devicePixelRatio so
  // the strokes stay crisp on HiDPI displays — signature_pad's docs
  // recommend this pattern. Re-runs on window resize so rotating a
  // phone doesn't break the input.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * ratio;
      canvas.height = rect.height * ratio;
      const ctx = canvas.getContext('2d');
      ctx?.scale(ratio, ratio);
      padRef.current?.clear(); // canvas resize clears the buffer
    };
    padRef.current = new SignaturePad(canvas, {
      penColor: '#111',
      backgroundColor: 'rgba(255, 255, 255, 0)',
    });
    resize();
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      padRef.current?.off();
      padRef.current = null;
    };
  }, [data]); // re-run if the contract loads after the canvas mounts

  /** Handle a failed action; returns true when it was a lost grant. */
  function handleAccessError(err: unknown): boolean {
    if (!adapter.verification || !isVerificationRequired(err)) return false;
    setError(null);
    setVerificationNotice(t('documentVerification.sessionExpired',
      "For your security, please confirm it's you again.") as string);
    adapter.verification.onAccessLost();
    return true;
  }

  const signMutation = useMutation({
    mutationFn: async () => {
      const pad = padRef.current;
      // Downscale the signature image before exporting. The canvas is
      // sized to its CSS dimensions × devicePixelRatio (resize effect
      // above) so on a 4× retina display we'd otherwise ship a ~1 MB
      // PNG to the server. Cap the export at MAX_SIGNATURE_WIDTH px
      // wide — preserves the visual fidelity needed for a legible
      // signature stamp while keeping the payload well under the
      // server's SIGNATURE_TOO_LARGE cap (1 MB base64). The
      // downscale uses a temporary canvas + drawImage to bilinear-
      // sample; signature_pad has no built-in export-size option.
      const canvas = canvasRef.current;
      const signatureDataUrl = (pad && canvas && !pad.isEmpty())
        ? downscaleSignature(pad, canvas)
        : null;
      return adapter.sign({
        name: name.trim(),
        signatureDataUrl,
        accepted: true,
      });
    },
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: adapter.queryKey });
    },
    onError: (err: any) => {
      if (handleAccessError(err)) return;
      setError(err?.response?.data?.error || 'Failed to sign');
    },
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => adapter.uploadSignedPdf(file),
    onSuccess: () => {
      setError(null);
      setUploadFile(null);
      queryClient.invalidateQueries({ queryKey: adapter.queryKey });
    },
    onError: (err: any) => {
      if (handleAccessError(err)) return;
      setError(err?.response?.data?.error || 'Upload failed');
    },
  });

  function handleSign(e: React.FormEvent) {
    e.preventDefault();
    if (!accepted) {
      setError(t('publicContract.errorAccept', 'Please tick the acceptance box.') as string);
      return;
    }
    if (!name.trim()) {
      setError(t('publicContract.errorName', 'Please enter your name.') as string);
      return;
    }
    // Client-side enforcement of the admin's "require drawn signature"
    // toggle. The server re-checks; this just gives a clearer error
    // before the round-trip.
    if (contract?.requireDrawnSignature && (!padRef.current || padRef.current.isEmpty())) {
      setError(t('publicContract.errorSignatureRequired',
        'A drawn signature is required for this contract.') as string);
      return;
    }
    setError(null);
    signMutation.mutate();
  }

  // The PDF needs the access grant (or the portal session), so it is fetched
  // as a blob rather than linked. The window opens synchronously so the
  // popup blocker accepts the click as the user gesture.
  async function handleDownload() {
    const w = window.open('about:blank', '_blank');
    if (!w) {
      setError(t('publicContract.popupBlocked', 'Allow pop-ups for this site to download the PDF.') as string);
      return;
    }
    try {
      w.location.href = await adapter.pdfUrl();
    } catch (err: any) {
      w.close();
      if (handleAccessError(err)) return;
      setError(t('publicContract.downloadError', 'Download failed') as string);
    }
  }

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-50 dark:bg-neutral-900">
        <Loading />
      </div>
    );
  }

  const notAvailable = (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-900 flex items-center justify-center p-6">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-bold mb-2 text-neutral-900 dark:text-neutral-100">
          {t('publicContract.notFoundTitle', 'Contract not available')}
        </h1>
        <p className="text-neutral-600 dark:text-neutral-400">
          {t('publicContract.notFoundBody', 'This signing link is invalid or expired. Please contact the sender.')}
        </p>
      </div>
    </div>
  );

  if (isError || !data) return notAvailable;

  if (isShell(data.contract)) {
    if (!adapter.verification) return notAvailable;
    const { verification } = adapter;
    return (
      <DocumentVerificationStep
        issuer={data.contract.issuer}
        emailHint={data.contract.emailHint}
        isDark={isDark}
        notice={verificationNotice}
        requestCode={verification.requestCode}
        confirmCode={verification.confirmCode}
        onVerified={(access) => {
          setVerificationNotice(null);
          verification.onVerified(access);
        }}
      />
    );
  }

  const c = data.contract;
  const locale = (c.language === 'de' ? 'de' : 'en') as 'en' | 'de';
  const alreadySigned =
    c.status === 'signed_by_customer'
    || c.status === 'signed_by_admin'
    || c.status === 'fully_signed';

  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100">
      <div className="max-w-3xl mx-auto py-8 px-4">
        {/* Issuer header — same shape as QuoteResponsePage. */}
        <div className="text-center mb-6">
          {(() => {
            const logo = isDark
              ? (c.issuer?.logoUrlDark || c.issuer?.logoUrl)
              : (c.issuer?.logoUrl || c.issuer?.logoUrlDark);
            return logo ? (
              <img
                src={logo}
                alt={c.issuer?.companyName || 'Logo'}
                className="mx-auto mb-3 h-16 object-contain"
              />
            ) : null;
          })()}
          {c.issuer?.companyName && (
            <h2 className="text-xl font-bold">{c.issuer.companyName}</h2>
          )}
          {c.issuer?.website && (
            <p className="text-sm text-neutral-500 dark:text-neutral-400">{c.issuer.website}</p>
          )}
        </div>

        {/* Main card */}
        <div className="bg-white dark:bg-neutral-800 rounded-xl shadow-sm border border-neutral-200 dark:border-neutral-700 p-6 md:p-8">
          <div className="flex items-baseline justify-between mb-4 gap-3 flex-wrap">
            <h1 className="text-2xl font-bold">
              {c.title || t('publicContract.fallbackTitle', 'Contract')}
            </h1>
            <span className="text-xs font-mono px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-700 text-neutral-600 dark:text-neutral-300">
              {c.contractNumber}
            </span>
          </div>

          {c.recipient && (
            <div className="mb-4 text-sm text-neutral-700 dark:text-neutral-300">
              <p className="font-medium">{c.recipient.companyName || c.recipient.displayName}</p>
              <p className="text-neutral-500 dark:text-neutral-400">{c.recipient.email}</p>
            </div>
          )}

          {c.introText && (
            <p className="whitespace-pre-line text-neutral-700 dark:text-neutral-300 my-4">
              {c.introText}
            </p>
          )}

          {/* Sections + blocks */}
          {c.sections.map((sec) => (
            <section key={sec.section} className="mt-6">
              <h2 className="text-lg font-semibold border-b border-neutral-200 dark:border-neutral-700 pb-1 mb-3">
                {SECTION_LABELS[sec.section]?.[locale] || sec.section}
              </h2>
              {sec.blocks.map((blk) => (
                <article key={blk.blockId} className="mb-4">
                  <h3 className="font-semibold text-sm mb-1">{blk.name}</h3>
                  <p className="text-sm whitespace-pre-line leading-6 text-neutral-700 dark:text-neutral-300">
                    {blk.body}
                  </p>
                </article>
              ))}
            </section>
          ))}

          {c.outroText && (
            <p className="whitespace-pre-line text-neutral-700 dark:text-neutral-300 mt-6">
              {c.outroText}
            </p>
          )}
        </div>

        {/* Signing card */}
        <div className="mt-6 bg-white dark:bg-neutral-800 rounded-xl shadow-sm border border-neutral-200 dark:border-neutral-700 p-6 md:p-8">
          {alreadySigned ? (
            <div className="py-2">
              <div className="text-center mb-5">
                <CheckCircle className="w-12 h-12 mx-auto text-green-600 mb-3" />
                <h2 className="text-lg font-semibold">
                  {t('publicContract.signed.title', 'Thank you — the contract is signed.')}
                </h2>
                {c.signedCustomerName && (
                  <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
                    {t('publicContract.signed.by', 'Signed by')}: {c.signedCustomerName}
                  </p>
                )}
                {c.signedByAdminAt && c.signedAdminName && (
                  <p className="text-sm text-neutral-600 dark:text-neutral-400">
                    {t('publicContract.signed.counterBy', 'Counter-signed by')}: {c.signedAdminName}
                  </p>
                )}
              </div>

              {/* Download button. Streams whatever is the most
                  authoritative copy on disk (signed_pdf_path when
                  present, otherwise pdf_path). */}
              <div className="text-center mb-5">
                <button
                  type="button"
                  onClick={handleDownload}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-accent-dark text-white text-sm hover:opacity-90"
                >
                  <Download className="w-4 h-4" />
                  {c.hasSignedPdf
                    ? t('publicContract.downloadSigned', 'Download signed PDF')
                    : t('publicContract.download', 'Download PDF')}
                </button>
                {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
              </div>

              {/* Audit confirmation — issue #4. Surfaces every piece
                  of evidence we recorded so the customer can save /
                  screenshot it for their own records. Re-hashing the
                  downloaded PDF and comparing against pdfSha256 is
                  the cryptographic proof the file wasn't tampered
                  with after we issued it. */}
              <details className="border-t border-neutral-200 dark:border-neutral-700 pt-4">
                <summary className="text-sm font-semibold cursor-pointer inline-flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4" />
                  {t('publicContract.signed.auditTitle', 'Signing audit trail')}
                </summary>
                <p className="text-xs text-neutral-600 dark:text-neutral-400 mt-2 mb-3">
                  {t('publicContract.signed.auditBody',
                    'For your records. Save or screenshot this — the SHA-256 hash lets you prove later that the PDF you downloaded is exactly what we issued (re-hash the file you have and compare).')}
                </p>
                <dl className="text-xs grid grid-cols-1 sm:grid-cols-[140px_1fr] gap-x-3 gap-y-1.5 font-mono">
                  <dt className="text-neutral-500">{t('publicContract.signed.contractNumber', 'Contract')}</dt>
                  <dd>{c.contractNumber}</dd>
                  {c.signedByCustomerAt && (
                    <>
                      <dt className="text-neutral-500">{t('publicContract.signed.signedAt', 'Signed at')}</dt>
                      <dd>{new Date(c.signedByCustomerAt).toISOString()}</dd>
                    </>
                  )}
                  {c.signedCustomerIp && (
                    <>
                      <dt className="text-neutral-500">{t('publicContract.signed.ipAddress', 'IP at signing')}</dt>
                      <dd>{c.signedCustomerIp}</dd>
                    </>
                  )}
                  {c.signedByAdminAt && (
                    <>
                      <dt className="text-neutral-500">{t('publicContract.signed.counterSignedAt', 'Counter-signed at')}</dt>
                      <dd>{new Date(c.signedByAdminAt).toISOString()}</dd>
                    </>
                  )}
                  {/* Admin counter-sign IP intentionally NOT rendered
                      to the customer — it's the operator's identifier,
                      not part of what the customer needs to audit. The
                      backend no longer ships signedAdminIp on the
                      public payload as of A.6 security hardening. */}
                  {c.signedPdfSha256 && (
                    <>
                      <dt className="text-neutral-500">{t('publicContract.signed.signedSha', 'Signed PDF SHA-256')}</dt>
                      <dd className="break-all">{c.signedPdfSha256}</dd>
                    </>
                  )}
                  {c.pdfSha256 && (
                    <>
                      <dt className="text-neutral-500">{t('publicContract.signed.unsignedSha', 'Original PDF SHA-256')}</dt>
                      <dd className="break-all">{c.pdfSha256}</dd>
                    </>
                  )}
                </dl>
              </details>
            </div>
          ) : !c.canSign ? (
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              {t('publicContract.notSignable', 'This contract can no longer be signed online. Please contact the sender.')}
            </p>
          ) : (
            <>
              <h2 className="text-lg font-semibold mb-3">
                {t('publicContract.signTitle', 'Sign this contract')}
              </h2>

              <form onSubmit={handleSign} className="space-y-3">
                <div>
                  <label htmlFor="contract-signer-name" className="block text-sm font-medium mb-1">
                    {t('publicContract.nameField', 'Your full name')}
                  </label>
                  <input
                    id="contract-signer-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 text-sm text-neutral-900 dark:text-neutral-100"
                    autoComplete="name"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">
                    {c.requireDrawnSignature
                      ? t('publicContract.signaturePromptRequired', 'Draw your signature')
                      : t('publicContract.signaturePrompt', 'Draw your signature (optional)')}
                  </label>
                  <canvas
                    ref={canvasRef}
                    className="w-full h-32 bg-white rounded border border-neutral-300 dark:border-neutral-600 touch-none"
                  />
                  <div className="mt-1 flex justify-end">
                    <button
                      type="button"
                      onClick={() => padRef.current?.clear()}
                      className="text-xs text-neutral-600 dark:text-neutral-400 hover:underline inline-flex items-center gap-1"
                    >
                      <RotateCcw className="w-3 h-3" />
                      {t('publicContract.clearSignature', 'Clear')}
                    </button>
                  </div>
                </div>

                <label className="flex items-start gap-2 text-sm text-neutral-700 dark:text-neutral-300">
                  <input
                    type="checkbox"
                    checked={accepted}
                    onChange={(e) => setAccepted(e.target.checked)}
                    className="mt-1"
                  />
                  <span>
                    {t(
                      'publicContract.acceptCheckbox',
                      'I have read this contract and agree to be bound by its terms.',
                    )}
                  </span>
                </label>

                {error && <p className="text-sm text-red-600">{error}</p>}

                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={signMutation.isPending}
                    className="px-4 py-2 rounded-md bg-accent-dark text-white text-sm hover:opacity-90 disabled:opacity-50"
                  >
                    {t('publicContract.submit', 'Sign contract')}
                  </button>
                </div>
              </form>

              {/* Alternative: upload wet-signed PDF. Hidden when the
                  admin has turned off the upload path in Settings →
                  CRM behaviour → Contracts. */}
              {c.allowPdfUpload !== false && (
              <div className="mt-6 pt-4 border-t border-neutral-200 dark:border-neutral-700">
                <h3 className="text-sm font-semibold mb-2">
                  {t('publicContract.uploadAlternative', 'Or upload a wet-signed PDF')}
                </h3>
                <p className="text-xs text-neutral-600 dark:text-neutral-400 mb-2">
                  {t(
                    'publicContract.uploadHint',
                    'Sign the printed contract by hand, scan it, and upload the PDF here.',
                  )}
                </p>
                <div className="flex items-center gap-2 flex-wrap">
                  <input
                    type="file"
                    accept="application/pdf"
                    onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                    className="text-sm text-neutral-700 dark:text-neutral-300"
                  />
                  <button
                    type="button"
                    disabled={!uploadFile || uploadMutation.isPending}
                    onClick={() => uploadFile && uploadMutation.mutate(uploadFile)}
                    className="px-3 py-1.5 rounded-md border border-neutral-300 dark:border-neutral-600 text-sm inline-flex items-center gap-1 disabled:opacity-50 text-neutral-700 dark:text-neutral-300"
                  >
                    <Upload className="w-4 h-4" />
                    {t('publicContract.uploadButton', 'Upload signed PDF')}
                  </button>
                </div>
              </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

/** Public route `/contract/:token`: the emailed link, gated by the one-time code. */
/** The single-link flow for a contract sent before signatures v2. */
const LegacyPublicContractResponse: React.FC = () => {
  const { token = '' } = useParams<{ token: string }>();
  const [grant, setGrant] = useState<string | null>(() => (token ? readDocumentGrant('contract', token) : null));
  // Bumped whenever access changes so the contract is fetched again with (or
  // without) the grant. The grant itself stays out of the query cache key.
  const [accessVersion, setAccessVersion] = useState(0);

  const adapter = useMemo<ContractDocumentAdapter>(() => ({
    queryKey: ['public-contract', token, accessVersion],
    load: async () => {
      const result = await publicContractsService.get(token, grant);
      // The server answered with the verification shell although we sent a
      // grant: it expired or was revoked, so don't offer it again.
      if (grant && isShell(result.contract)) clearDocumentGrant('contract', token);
      return result;
    },
    sign: (payload) => publicContractsService.sign(token, payload, grant),
    uploadSignedPdf: (file) => publicContractsService.uploadSignedPdf(token, file, grant),
    pdfUrl: () => publicContractsService.pdfUrl(token, grant),
    verification: {
      requestCode: () => publicContractsService.requestVerification(token),
      confirmCode: (code) => publicContractsService.confirmVerification(token, code),
      onVerified: (access) => {
        storeDocumentGrant('contract', token, access);
        setGrant(access.grant);
        setAccessVersion((v) => v + 1);
      },
      onAccessLost: () => {
        clearDocumentGrant('contract', token);
        setGrant(null);
        setAccessVersion((v) => v + 1);
      },
    },
  }), [token, grant, accessVersion]);

  return <ContractResponseView adapter={adapter} />;
};
