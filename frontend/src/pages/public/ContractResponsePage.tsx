/**
 * Public contract response page. No authentication — the link in the
 * customer's email is the only secret.
 *
 * Two signing paths offered side-by-side:
 *   1. In-browser: customer types their full name, optionally draws a
 *      signature on a small canvas (signature_pad), ticks "I have read
 *      and agree", and submits. Server captures IP + timestamp + the
 *      signature image, re-renders the PDF with the signature stamped,
 *      and emails the admin a notification.
 *   2. Upload wet-signed PDF: customer can sign physically and upload
 *      the PDF instead. Server treats this as the authoritative copy.
 *
 * Visual treatment matches QuoteResponsePage so admins get a consistent
 * customer-facing surface: branding-aware dark/light mode via
 * usePublicDarkMode, issuer logo + name header, neutral card styling.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import SignaturePad from 'signature_pad';
import { CheckCircle, Upload, RotateCcw, Download, ShieldCheck } from 'lucide-react';
import { Loading } from '../../components/common';
import { usePublicDarkMode } from '../../hooks/usePublicDarkMode';
import {
  publicContractsService,
  type ContractBlockSection,
} from '../../services/contracts.service';

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

const SECTION_LABELS: Record<ContractBlockSection, { en: string; de: string }> = {
  basics: { en: 'Basics', de: 'Vertragsgrundlagen' },
  scope: { en: 'Scope', de: 'Leistungsumfang' },
  privacy: { en: 'Privacy', de: 'Persönlichkeitsrechte & Datenschutz' },
  commercial: { en: 'Commercial', de: 'Kaufmännisches' },
  nda: { en: 'Confidentiality', de: 'Vertraulichkeit' },
  closing: { en: 'Closing', de: 'Schlussbestimmungen' },
};

export const ContractResponsePage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { token } = useParams<{ token: string }>();
  const queryClient = useQueryClient();
  // Honour branding dark/light mode the same way QuoteResponsePage
  // does — without this the page renders in light regardless of admin
  // settings. The wrapper styling below still has `dark:` variants
  // so the page reads cleanly in either mode. `isDark` drives the
  // theme-aware logo pick in the header.
  const { isDark } = usePublicDarkMode();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const padRef = useRef<SignaturePad | null>(null);

  const [name, setName] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['public-contract', token],
    queryFn: () => publicContractsService.get(token as string),
    enabled: !!token,
    retry: false,
  });

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
      return publicContractsService.sign(token as string, {
        name: name.trim(),
        signatureDataUrl,
        accepted: true,
      });
    },
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ['public-contract', token] });
    },
    onError: (err: any) => setError(err?.response?.data?.error || 'Failed to sign'),
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => publicContractsService.uploadSignedPdf(token as string, file),
    onSuccess: () => {
      setError(null);
      setUploadFile(null);
      queryClient.invalidateQueries({ queryKey: ['public-contract', token] });
    },
    onError: (err: any) => setError(err?.response?.data?.error || 'Upload failed'),
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
    if (data?.contract.requireDrawnSignature && (!padRef.current || padRef.current.isEmpty())) {
      setError(t('publicContract.errorSignatureRequired',
        'A drawn signature is required for this contract.') as string);
      return;
    }
    setError(null);
    signMutation.mutate();
  }

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-50 dark:bg-neutral-900">
        <Loading />
      </div>
    );
  }

  if (isError || !data) {
    return (
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

              {/* Download button — issue #2. Streams whatever is the
                  most authoritative copy on disk (signed_pdf_path when
                  present, otherwise pdf_path). Sync-opens about:blank
                  pre-fetch so the popup-blocker accepts the gesture. */}
              <div className="text-center mb-5">
                <a
                  href={`/api/public/contracts/${token}/pdf`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-accent-dark text-white text-sm hover:opacity-90"
                >
                  <Download className="w-4 h-4" />
                  {c.hasSignedPdf
                    ? t('publicContract.downloadSigned', 'Download signed PDF')
                    : t('publicContract.download', 'Download PDF')}
                </a>
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
          ) : (
            <>
              <h2 className="text-lg font-semibold mb-3">
                {t('publicContract.signTitle', 'Sign this contract')}
              </h2>

              <form onSubmit={handleSign} className="space-y-3">
                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t('publicContract.nameField', 'Your full name')}
                  </label>
                  <input
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
