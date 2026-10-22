import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  quotesService,
  type ConfigurationDefinition,
} from '../../services/quotes.service';
import { albumProducts, type Choice, type Product } from './model';
import {
  ConfigurationPicker,
  choiceValues,
  type ConfigurationValues,
} from './ConfigurationPicker';
export function QuoteLineConfiguration({
  presetId,
  definition,
  snapshot,
  values,
  locked,
  currency,
  onChange,
}: {
  presetId?: number | null;
  definition?: ConfigurationDefinition | null;
  snapshot?: Choice | null;
  values?: ConfigurationValues;
  locked?: boolean;
  currency: string;
  onChange: (values: ConfigurationValues, locked: boolean) => void;
}) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ['quote-product-configuration-sources'],
    enabled: !definition && !!presetId,
    staleTime: 30_000,
    queryFn: async () => {
      const [catalogue, { presets }] = await Promise.all([
        albumProducts.catalogue(),
        quotesService.listLineItemPresets(),
      ]);
      return { catalogue, presets };
    },
    retry: false,
  });
  const preset = query.data?.presets.find((p) => p.id === presetId);
  const catalogue = query.data?.catalogue;
  const source = catalogue?.products.find(
    (p) => p.id === preset?.productId && p.active,
  );
  const type = catalogue?.types?.find(
    (t) => t.id === source?.typeId && t.active,
  );
  const resolved: Product | null =
    source && type
      ? {
          ...source,
          attributes: type.attributes.map((a) => ({
            ...a,
            options: (
              catalogue?.library?.find((g) => g.id === a.groupId)?.options || []
            ).filter((o) => o.active && a.optionIds.includes(o.id)),
          })),
        }
      : null;
  const product = definition?.product || resolved;
  if (!product)
    return query.isError ? (
      <p role="alert">
        {t(
          'products.prefillLoadError',
          'Unable to load product choices. Save and reload the quote to try again.',
        )}
      </p>
    ) : null;
  const selected = values ?? choiceValues(snapshot);
  return (
    <details className="mt-3 rounded border border-line p-3">
      <summary className="cursor-pointer">
        {t('products.quoteConfiguration', 'Product choices and client lock')}
      </summary>
      <div className="mt-3 space-y-3">
        <ConfigurationPicker
          product={product}
          values={selected}
          onChange={(v) => onChange(v, !!locked)}
          currency={currency}
          surcharges={definition?.surcharges || preset?.productSurcharges}
        />
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={!!locked}
            onChange={(e) => onChange(selected, e.target.checked)}
          />
          {t(
            'products.lockQuoteConfiguration',
            'Lock this agreed specification for the client',
          )}
        </label>
        <p className="text-xs text-muted">
          {t(
            'products.prefillHelp',
            'A locked specification must be complete. Leave it unlocked to let the client finish or change the choices. Prices are recalculated when you save.',
          )}
        </p>
      </div>
    </details>
  );
}
