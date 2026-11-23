/** Constants the two accounting pages (inbox, expenses ledger) share. */
import type { PaymentMethod } from '../../../services/accounting.service';

export const PAYMENT_METHODS: PaymentMethod[] = ['bank_transfer', 'cash', 'twint', 'paypal', 'card', 'other'];
export const labelCls = 'block text-sm font-medium text-body mb-1';
export const selectCls = 'w-full rounded-md border border-line-strong bg-panel px-3 py-2 text-sm';
