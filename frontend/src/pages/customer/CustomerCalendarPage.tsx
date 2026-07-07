import React from 'react';
import { Calendar } from 'lucide-react';
import { CustomerComingSoonPage } from './CustomerComingSoonPage';

export const CustomerCalendarPage: React.FC = () => (
  <CustomerComingSoonPage
    titleKey="customer.calendar.title"
    titleFallback="Calendar"
    bodyKey="customer.calendar.body"
    bodyFallback="Upcoming sessions, gallery delivery dates, and other shoot-related events will land here. We'll let you know when it's ready."
    icon={Calendar}
  />
);

export default CustomerCalendarPage;
