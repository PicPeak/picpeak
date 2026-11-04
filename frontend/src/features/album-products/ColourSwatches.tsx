import { Check } from 'lucide-react';
import { ProductImage } from './ProductImage';
import type { Option } from './model';

/** Black or white, whichever reads on the swatch. */
function checkColour(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#000000' : '#ffffff';
}

/**
 * Round colour choices. Each is a real radio with a visible label, so the
 * arrow keys, focus and screen readers work as for any radio group. An option
 * without a colour value falls back to its image, then to an empty circle.
 */
export function ColourSwatches({
  name,
  legend,
  options,
  value,
  onChange,
  slug,
  disabled = false,
  priceOf,
}: {
  name: string;
  legend: string;
  options: Option[];
  value?: string;
  onChange: (id: string) => void;
  slug?: string;
  disabled?: boolean;
  priceOf?: (optionId: string) => string | null;
}) {
  return (
    <fieldset disabled={disabled}>
      <legend className="sr-only">{legend}</legend>
      <div className="flex flex-wrap gap-x-3 gap-y-5">
        {options.map((option) => {
          const selected = value === option.id;
          return (
            <label
              key={option.id}
              className="flex w-24 cursor-pointer flex-col items-center gap-2 text-center text-sm"
            >
              <input
                type="radio"
                className="peer sr-only"
                name={name}
                value={option.id}
                checked={selected}
                onChange={() => onChange(option.id)}
              />
              <span
                aria-hidden="true"
                data-swatch={option.hex || ''}
                className="relative flex h-16 w-16 items-center justify-center overflow-hidden rounded-full border border-border-token peer-checked:outline peer-checked:outline-2 peer-checked:outline-offset-2 peer-checked:outline-accent peer-focus-visible:ring-2 peer-focus-visible:ring-text-primary peer-focus-visible:ring-offset-4"
                style={option.hex ? { backgroundColor: option.hex } : undefined}
              >
                {!option.hex && option.imageId && (
                  <ProductImage imageId={option.imageId} alt="" slug={slug} />
                )}
                {selected && (
                  <Check
                    className="absolute h-6 w-6"
                    style={{ color: option.hex ? checkColour(option.hex) : undefined }}
                  />
                )}
              </span>
              <span className={selected ? 'font-semibold' : undefined}>{option.name}</span>
              {priceOf?.(option.id) && <span>{priceOf(option.id)}</span>}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** A non-interactive swatch, for the portal and the admin alike; `large` in an album's overview. */
export function SwatchDot({ hex, large = false }: { hex?: string; large?: boolean }) {
  if (!hex) return null;
  return (
    <span
      aria-hidden="true"
      className={`inline-block rounded-full ${large ? 'h-8 w-8 align-middle' : 'h-4 w-4 align-text-bottom'}`}
      style={{ backgroundColor: hex, boxShadow: 'inset 0 0 0 1px rgba(0, 0, 0, 0.15)' }}
    />
  );
}
