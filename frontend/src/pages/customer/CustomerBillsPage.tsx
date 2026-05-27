import React from 'react';
import { Receipt } from 'lucide-react';
import { CustomerComingSoonPage } from './CustomerComingSoonPage';

export const CustomerBillsPage: React.FC = () => (
  <CustomerComingSoonPage
    titleKey="customer.bills.title"
    titleFallback="Bills"
    bodyKey="customer.bills.body"
    bodyFallback="Invoices and payment history for your sessions will be available here. We'll send you an email when this is live."
    icon={Receipt}
  />
);

export default CustomerBillsPage;
