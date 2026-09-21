import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Upload, X } from 'lucide-react';
import { Button, Card, Loading } from '../../../components/common';
import { contractsService } from '../../../services/contracts.service';

/**
 * Uploading a wet-signed contract (#1446).
 *
 * The upload replaces the whole document and completes the contract for
 * everyone, and the server cannot read whose signatures the paper actually
 * bears — so the admin states it. Every customer signer who has not signed in
 * the browser (or declined) has to be confirmed, or the server refuses the
 * upload. Once anyone has signed in the browser the server refuses the upload
 * outright — the paper would discard that signature — so the dialog explains
 * that and offers no upload.
 */
interface PaperSignatureUploadDialogProps {
  contractId: number;
  isOpen: boolean;
  onClose: () => void;
  onUpload: (file: File, coversSignerIds: number[]) => void;
  isUploading?: boolean;
}

export const PaperSignatureUploadDialog: React.FC<PaperSignatureUploadDialogProps> = ({
  contractId, isOpen, onClose, onUpload, isUploading = false,
}) => {
  const { t } = useTranslation();
  const [file, setFile] = useState<File | null>(null);
  const [ticked, setTicked] = useState<number[]>([]);

  const coverageQuery = useQuery({
    queryKey: ['contract-paper-coverage', contractId],
    queryFn: () => contractsService.paperSignatureCoverage(contractId),
    enabled: isOpen,
  });

  if (!isOpen) return null;

  const signers = coverageQuery.data?.signers ?? [];
  const refused = coverageQuery.data?.electronicSignaturePresent === true;
  const allTicked = signers.every((s) => ticked.includes(s.id));
  const canUpload = !!file && allTicked && !refused && !isUploading && !coverageQuery.isLoading;

  const toggle = (id: number) => setTicked((current) => (
    current.includes(id) ? current.filter((x) => x !== id) : [...current, id]
  ));

  const close = () => {
    setFile(null);
    setTicked([]);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <Card className="w-full max-w-lg">
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
              {t('contracts.paperUpload.title', 'Upload a signed contract')}
            </h2>
            <button
              type="button"
              onClick={close}
              disabled={isUploading}
              className="p-1 hover:bg-neutral-100 dark:hover:bg-neutral-700 rounded-lg transition-colors"
              aria-label={t('common.close', 'Close') as string}
            >
              <X className="w-5 h-5 text-neutral-500 dark:text-neutral-400" />
            </button>
          </div>

          <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
            {t('contracts.paperUpload.intro',
              'The uploaded PDF becomes the authoritative signed contract. It is sent to both parties and every signing link stops working.')}
          </p>

          {coverageQuery.isLoading ? (
            <Loading />
          ) : refused ? (
            <div className="mb-4 p-4 rounded-md border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950/30">
              <h3 className="text-sm font-semibold text-red-900 dark:text-red-200 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4" />
                {t('contracts.paperUpload.refusedTitle', 'Already signed in the browser')}
              </h3>
              <p className="text-sm text-red-900 dark:text-red-200 mt-1">
                {t('contracts.paperUpload.refusedBody',
                  'At least one signer has already signed this contract in the browser. A paper copy can\'t replace a signature given in the browser, so the upload isn\'t available. Let the remaining signers sign in the browser, then counter-sign on this page.')}
              </p>
            </div>
          ) : signers.length > 0 && (
            <div className="mb-4 p-4 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30">
              <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-200 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4" />
                {t('contracts.paperUpload.confirmTitle', 'Whose signatures does this copy carry?')}
              </h3>
              <p className="text-sm text-amber-900 dark:text-amber-200 mt-1">
                {t('contracts.paperUpload.confirmBody',
                  'This upload completes the contract for everyone below, so confirm that the paper copy is signed by each of them. What you confirm is recorded in the signing log.')}
              </p>
              <ul className="mt-3 space-y-2">
                {signers.map((signer) => (
                  <li key={signer.id}>
                    <label className="flex items-start gap-2 text-sm text-neutral-900 dark:text-neutral-100">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={ticked.includes(signer.id)}
                        onChange={() => toggle(signer.id)}
                        disabled={isUploading}
                      />
                      <span>
                        {signer.name || t('contracts.paperUpload.unnamedSigner', 'Signer {{position}}', { position: signer.position })}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!refused && (
            <>
              <label htmlFor="paper-signature-file" className="block text-sm font-medium mb-1 text-neutral-900 dark:text-neutral-100">
                {t('contracts.paperUpload.fileLabel', 'The signed PDF')}
              </label>
              <input
                id="paper-signature-file"
                type="file"
                accept="application/pdf"
                disabled={isUploading}
                onChange={(e) => setFile(e.target.files?.[0] || null)}
                className="text-sm text-neutral-700 dark:text-neutral-300"
              />
            </>
          )}

          <div className="mt-6 flex justify-end gap-3">
            <Button variant="outline" onClick={close} disabled={isUploading}>
              {t('common.cancel', 'Cancel')}
            </Button>
            {!refused && (
              <Button
                onClick={() => file && onUpload(file, ticked)}
                disabled={!canUpload}
              >
                <Upload className="w-4 h-4 mr-1" />
                {isUploading
                  ? t('contracts.paperUpload.uploading', 'Uploading…')
                  : t('contracts.paperUpload.submit', 'Upload signed PDF')}
              </Button>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
};
