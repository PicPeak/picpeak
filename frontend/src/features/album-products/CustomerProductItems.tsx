import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Card, Button, Loading } from '../../components/common';
import { usePermissions } from '../../contexts/PermissionsContext';
import { useFeatureEnabled } from '../../contexts/FeatureFlagsContext';
import { api } from '../../config/api';
import { formatMoneyMinor } from '../../utils/money';
import { errorMessage } from './model';
interface Item {
  id: number;
  invoice_id: number | null;
  currency: string;
  vat_code: string;
  vat_rate: string | number;
  line_item: string;
}
function Items({ customerAccountId }: { customerAccountId: number }) {
  const { t } = useTranslation(),
    { hasPermission } = usePermissions(),
    navigate = useNavigate();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const endpoint = `/admin/album-products/customers/${customerAccountId}/billing`;
  const query = useQuery({
    queryKey: ['customer-product-items', customerAccountId],
    queryFn: () => api.get<{ items: Item[] }>(endpoint).then((r) => r.data),
    staleTime: 30_000,
  });
  const groups = new Map<string, Item[]>();
  for (const item of query.data?.items || [])
    if (!item.invoice_id) {
      const key = `${item.currency}:${item.vat_code}:${item.vat_rate}`;
      groups.set(key, [...(groups.get(key) || []), item]);
    }
  const bill = async (items: Item[]) => {
    setBusy(true);
    setError('');
    try {
      const result = await api.post<{ invoiceId: number }>(endpoint, {
        itemIds: items.map((i) => i.id),
      });
      await query.refetch();
      navigate(`/admin/clients/bills/${result.data.invoiceId}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="p-6 space-y-3">
      <h2 className="text-lg font-semibold">
        {t('products.customerItems', 'Product items')}
      </h2>
      <p className="text-sm text-muted">
        {t(
          'products.customerItemsHelp',
          'Locked gallery choices are ready to bill here, including after the gallery is deleted. Each specification and its price stay frozen.',
        )}
      </p>
      {query.isLoading && <Loading />}
      {query.isError && (
        <p role="alert">
          {errorMessage(query.error)}{' '}
          <Button variant="secondary" onClick={() => query.refetch()}>
            {t('common.retry', 'Retry')}
          </Button>
        </p>
      )}
      {query.data?.items.length === 0 && (
        <p>{t('products.noProductItems', 'No product items yet.')}</p>
      )}
      {query.data?.items.map((item) => {
        const line = JSON.parse(item.line_item);
        return (
          <div key={item.id} className="border-b border-line pb-2">
            <strong>{line.description}</strong>
            <p className="text-sm">{line.details_text}</p>
            <p>
              {formatMoneyMinor(line.unit_price_minor, item.currency)} ·{' '}
              {item.invoice_id ? (
                <Link
                  className="underline"
                  to={`/admin/clients/bills/${item.invoice_id}`}
                >
                  {t('products.billedOnInvoice', 'Billed on invoice #{{id}}', {
                    id: item.invoice_id,
                  })}
                </Link>
              ) : (
                t('products.openBillable', 'Open product item')
              )}
            </p>
          </div>
        );
      })}
      {hasPermission('customers.edit') &&
        [...groups.entries()].map(([key, items]) => (
          <Button key={key} disabled={busy} onClick={() => bill(items)}>
            {t(
              'products.billOpenProducts',
              'Create invoice for open product items',
            )}{' '}
            · {items[0].currency} · {items[0].vat_code}
          </Button>
        ))}
      {error && (
        <p role="alert" className="text-danger-text">
          {error}
        </p>
      )}
    </Card>
  );
}
export function CustomerProductItems(props: { customerAccountId: number }) {
  const products = useFeatureEnabled('albumProducts'),
    bills = useFeatureEnabled('bills'),
    { hasPermission } = usePermissions();
  return products &&
    bills &&
    hasPermission('products.view') &&
    hasPermission('customers.view') &&
    hasPermission('bills.manage') ? (
    <Items {...props} />
  ) : null;
}
