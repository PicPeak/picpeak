import React from 'react';
import { FileText } from 'lucide-react';
import { CustomerComingSoonPage } from './CustomerComingSoonPage';

export const CustomerQuotesPage: React.FC = () => (
  <CustomerComingSoonPage
    titleKey="customer.quotes.title"
    titleFallback="Quotes"
    bodyKey="customer.quotes.body"
    bodyFallback="Review and accept quotes for upcoming shoots in one place. We're still building this — for now, your photographer will keep sending quotes the usual way."
    icon={FileText}
  />
);

export default CustomerQuotesPage;
