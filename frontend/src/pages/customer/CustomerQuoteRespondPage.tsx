/**
 * Portal quote response page (`/customer/quotes/:id/respond`).
 *
 * The quotes list used to link to the public response page with the raw
 * response token, handing a bearer secret to the portal. This page renders
 * the same view through the portal's session-authenticated routes instead:
 * no token reaches the browser, and a logged-in customer is not asked for an
 * emailed code.
 */
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { customerService } from '../../services/customer.service';
import {
  QuoteResponseView,
  type QuoteDocumentAdapter,
} from '../public/QuoteResponsePage';

export const CustomerQuoteRespondPage: React.FC = () => {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const quoteId = Number(id);

  const adapter = useMemo<QuoteDocumentAdapter>(() => ({
    queryKey: ['customer-quote', quoteId],
    // The portal's flag also knows whether a usable response link is left;
    // the shared view's own flag only looks at the quote status.
    load: async () => {
      const { quote, canRespond } = await customerService.getQuote(quoteId);
      return { quote: { ...quote, canRespond } };
    },
    respond: (action, options) => customerService.respondToQuote(quoteId, action, options),
  }), [quoteId]);

  return (
    <div>
      <div className="container pt-4">
        <Link
          to="/customer/quotes"
          className="inline-flex items-center gap-1 text-sm text-muted-theme hover:underline"
        >
          <ArrowLeft className="w-4 h-4" />
          {t('customer.quotes.backToList', 'Back to quotes')}
        </Link>
      </div>
      <QuoteResponseView adapter={adapter} />
    </div>
  );
};

export default CustomerQuoteRespondPage;
