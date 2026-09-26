/**
 * Book / Remove booking for an optional add-on (#1451) — one control for the
 * admin line editor, the quote detail page and the customer's quote page.
 * The button says what it does: Book is the call to action (filled, brand
 * colour); Remove booking stays a quiet outline. The caller shows the state
 * (Booked / Not booked) as the last line of the row, after the details.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';

interface AddOnBookButtonProps {
  booked: boolean;
  onToggle: () => void;
  disabled?: boolean;
}

export const AddOnBookButton: React.FC<AddOnBookButtonProps> = ({ booked, onToggle, disabled = false }) => {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      className={`rounded-md border px-2 py-0.5 font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-1 dark:focus-visible:ring-offset-neutral-900 disabled:cursor-not-allowed disabled:opacity-50 ${booked
        ? 'border-line-strong bg-panel text-body hover:bg-hover'
        : 'border-primary-600 bg-primary-600 text-white hover:bg-primary-700 hover:border-primary-700'}`}
    >
      {booked
        ? t('crm.lineItems.removeBooking', 'Remove booking')
        : t('crm.lineItems.book', 'Book')}
    </button>
  );
};

/** The add-on's state — the last line of its item, next to the button above. */
export const AddOnBookingState: React.FC<{ booked: boolean }> = ({ booked }) => {
  const { t } = useTranslation();
  return (
    <>
      {booked
        ? t('crm.lineItems.bookedInTotal', 'Booked')
        : t('crm.lineItems.offeredNotInTotal', 'Not booked')}
    </>
  );
};
