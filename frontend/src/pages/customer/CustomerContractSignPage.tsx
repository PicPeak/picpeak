/**
 * Portal signing page (`/customer/contracts/:id/sign`).
 *
 * The contracts list used to link to the public signing page with the raw
 * signing token, handing a long-lived bearer secret to the portal. This page
 * renders the same signing view through the portal's session-authenticated
 * routes instead: no token reaches the browser, and a logged-in customer is
 * not asked for an emailed code.
 */
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { customerService } from '../../services/customer.service';
import {
  ContractResponseView,
  type ContractDocumentAdapter,
} from '../public/ContractResponsePage';

export const CustomerContractSignPage: React.FC = () => {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const contractId = Number(id);

  const adapter = useMemo<ContractDocumentAdapter>(() => ({
    queryKey: ['customer-contract', contractId],
    // The portal's flag also knows whether a live signing link is left; the
    // shared view's own flag only looks at the contract status.
    load: async () => {
      const { contract, canSign } = await customerService.getContract(contractId);
      return { contract: { ...contract, canSign } };
    },
    sign: (payload) => customerService.signContract(contractId, payload),
    uploadSignedPdf: (file) => customerService.uploadSignedContractPdf(contractId, file),
    pdfUrl: () => customerService.contractPdfUrl(contractId),
  }), [contractId]);

  return (
    <div>
      <div className="container pt-4">
        <Link
          to="/customer/contracts"
          className="inline-flex items-center gap-1 text-sm text-muted-theme hover:underline"
        >
          <ArrowLeft className="w-4 h-4" />
          {t('customer.contracts.backToList', 'Back to contracts')}
        </Link>
      </div>
      <ContractResponseView adapter={adapter} />
    </div>
  );
};

export default CustomerContractSignPage;
