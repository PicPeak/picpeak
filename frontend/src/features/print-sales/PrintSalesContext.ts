import { createContext, useContext } from 'react';
export interface PrintSalesActions {
  available: boolean;
  count: number;
  hasOrders?: boolean;
  openPhoto: (id: number) => void;
  openBulk: () => void;
  openBasket: () => void;
}
export const PrintSalesContext = createContext<PrintSalesActions | null>(null);
export const usePrintSales = () => useContext(PrintSalesContext);
