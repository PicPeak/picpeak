import { useTranslation } from 'react-i18next';
import { formatMoneyMinor } from '../../utils/money';
import { ProductImage } from './ProductImage';
import type { Attribute, Choice, Product } from './model';
export type ConfigurationValues = Record<string, string[]>;
export const choiceValues = (choice?: Choice | null): ConfigurationValues =>
  Object.fromEntries(
    (choice?.attributes || []).map((a) => [a.id, a.options.map((o) => o.id)]),
  );
export function attributeEnabled(
  a: Attribute,
  attributes: Attribute[],
  values: ConfigurationValues,
): boolean {
  return a.dependsOn.every((d) => {
    const parent = attributes.find((p) => p.id === d.attributeId);
    return (
      !!parent &&
      attributeEnabled(parent, attributes, values) &&
      d.optionIds.some((id) => values[parent.id]?.includes(id))
    );
  });
}
export function pruneValues(
  attributes: Attribute[],
  values: ConfigurationValues,
): ConfigurationValues {
  return Object.fromEntries(
    attributes
      .filter((a) => attributeEnabled(a, attributes, values))
      .map((a) => [
        a.id,
        (values[a.id] || []).filter((id) => a.options.some((o) => o.id === id)),
      ]),
  );
}
export function ConfigurationPicker({
  product,
  values,
  onChange,
  disabled = false,
  slug,
  imageLoader,
  surcharges = [],
  currency,
}: {
  product: Product;
  values: ConfigurationValues;
  onChange: (values: ConfigurationValues) => void;
  disabled?: boolean;
  slug?: string;
  imageLoader?: (id: string) => Promise<Blob>;
  surcharges?: { attributeId: string; optionId: string; amountMinor: number }[];
  currency?: string;
}) {
  const { t } = useTranslation();
  const attributes = product.attributes || [];
  return (
    <div className="space-y-5">
      {attributes
        .filter((a) => attributeEnabled(a, attributes, values))
        .map((a) => (
          <fieldset key={a.id} disabled={disabled} className="space-y-2">
            <legend className="font-semibold">
              {a.name}{' '}
              <span className="text-sm font-normal">
                {a.required
                  ? t('products.required', 'Required')
                  : t('products.optional', 'Optional')}
                {a.multiple && ` · ${t('products.multiple', 'Choose any')}`}
              </span>
            </legend>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {a.options.map((option) => {
                const selected = values[a.id]?.includes(option.id) || false;
                const cost =
                  surcharges.find(
                    (s) => s.attributeId === a.id && s.optionId === option.id,
                  )?.amountMinor || 0;
                return (
                  <label
                    key={option.id}
                    className={`rounded-xl border border-border-token p-3 cursor-pointer min-w-0 ${selected ? 'tile-selected' : ''}`}
                  >
                    {option.imageId && (
                      <ProductImage
                        imageId={option.imageId}
                        alt={option.name}
                        slug={slug}
                        imageLoader={imageLoader}
                      />
                    )}
                    <span className="flex items-start gap-2 mt-2">
                      <input
                        type={a.multiple ? 'checkbox' : 'radio'}
                        name={`${product.id}-${a.id}`}
                        checked={selected}
                        aria-label={option.name}
                        onChange={() => {
                          const next = a.multiple
                            ? selected
                              ? (values[a.id] || []).filter(
                                  (id) => id !== option.id,
                                )
                              : [...(values[a.id] || []), option.id]
                            : [option.id];
                          onChange(
                            pruneValues(attributes, {
                              ...values,
                              [a.id]: next,
                            }),
                          );
                        }}
                      />
                      <span>
                        {option.name}
                        {option.width != null && (
                          <span className="block text-sm">
                            {option.width} × {option.height} {option.unit}
                          </span>
                        )}
                        {cost > 0 && currency && (
                          <span className="block text-sm">
                            +{formatMoneyMinor(cost, currency)}
                          </span>
                        )}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
            {!a.required && (values[a.id]?.length || 0) > 0 && (
              <button
                type="button"
                className="underline text-sm"
                onClick={() =>
                  onChange(pruneValues(attributes, { ...values, [a.id]: [] }))
                }
              >
                {t('products.clearChoice', 'Clear choice')}
              </button>
            )}
          </fieldset>
        ))}
    </div>
  );
}
export function ChoiceSummary({ choice }: { choice: Choice }) {
  return (
    <span>
      {choice.attributes
        ? choice.attributes
            .map((a) => `${a.name}: ${a.options.map((o) => o.name).join(', ')}`)
            .join(' · ')
        : [choice.model?.name, choice.colour?.name].filter(Boolean).join(' · ')}
    </span>
  );
}
