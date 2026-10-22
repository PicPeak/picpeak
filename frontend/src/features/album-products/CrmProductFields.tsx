import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { DecimalInput } from '../../components/common/DecimalInput';
import { albumProducts } from './model';
export interface Surcharge {
  attributeId: string;
  optionId: string;
  amountMinor: number;
}
export function CrmProductFields({
  productId,
  surcharges,
  onChange,
}: {
  productId: string | null;
  surcharges: Surcharge[];
  onChange: (id: string | null, surcharges: Surcharge[]) => void;
}) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ['product-catalogue'],
    queryFn: albumProducts.catalogue,
    retry: false,
  });
  const catalogue = query.data;
  if (!catalogue) return null;
  const product = catalogue.products.find((p) => p.id === productId);
  const type = catalogue.types?.find((type) => type.id === product?.typeId);
  return (
    <div className="space-y-3 col-span-full">
      <label className="block text-sm font-medium">
        {t('products.configurableProduct', 'Configurable product')}
        <select
          className="input"
          value={productId || ''}
          onChange={(e) => onChange(e.target.value || null, [])}
        >
          <option value="">
            {t('products.noConfiguration', 'No configuration')}
          </option>
          {catalogue.products
            .filter((p) => p.typeId && (p.active || p.id === productId))
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </select>
      </label>
      {type && (
        <details>
          <summary className="cursor-pointer text-sm">
            {t(
              'products.optionSurcharges',
              'Option surcharges (added to the base unit price)',
            )}
          </summary>
          <div className="grid sm:grid-cols-2 gap-3 mt-3">
            {type.attributes.flatMap((a) =>
              (
                catalogue.library?.find((g) => g.id === a.groupId)?.options ||
                []
              )
                .filter((o) => a.optionIds.includes(o.id))
                .map((o) => (
                  <label key={`${a.id}-${o.id}`} className="text-sm">
                    {a.name} · {o.name}
                    <DecimalInput
                      aria-label={`${a.name} · ${o.name}`}
                      value={
                        (surcharges.find(
                          (s) => s.attributeId === a.id && s.optionId === o.id,
                        )?.amountMinor || 0) / 100
                      }
                      fractionDigits={2}
                      onChange={(value) =>
                        onChange(productId, [
                          ...surcharges.filter(
                            (s) =>
                              s.attributeId !== a.id || s.optionId !== o.id,
                          ),
                          {
                            attributeId: a.id,
                            optionId: o.id,
                            amountMinor: Math.round(
                              (Number.isFinite(value) ? value : 0) * 100,
                            ),
                          },
                        ])
                      }
                    />
                  </label>
                )),
            )}
          </div>
        </details>
      )}
    </div>
  );
}
