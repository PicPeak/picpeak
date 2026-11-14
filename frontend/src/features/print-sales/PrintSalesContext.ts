import { createContext, useContext } from 'react';
export interface PrintSalesActions {
  available: boolean;
  /** Offers exist, but this login may only look (a view-only customer contact). */
  readOnly?: boolean;
  count: number;
  hasOrders?: boolean;
  openPhoto: (id: number) => void;
  openBulk: () => void;
  openBasket: () => void;
}
export const PrintSalesContext = createContext<PrintSalesActions | null>(null);
export const usePrintSales = () => useContext(PrintSalesContext);
