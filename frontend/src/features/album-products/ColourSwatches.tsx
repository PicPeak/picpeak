import { Check } from 'lucide-react';
import { ProductImage } from './ProductImage';
import type { Option } from './model';

/** Black or white, whichever reads on the swatch. */
function checkColour(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#000000' : '#ffffff';
}

/**
 * Colour choices. Each is a real radio with a visible label, so the arrow
 * keys, focus and screen readers work as for any radio group. Plain colour
 * values are round swatches. As soon as one option has a picture, every
 * option becomes a 3:2 tile like the material and format steps, so a photo of
 * the cover is shown whole instead of cut to a circle; a colour value without
 * a picture fills its tile.
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
  if (options.some((option) => option.imageId)) {
    return (
      <fieldset disabled={disabled}>
        <legend className="sr-only">{legend}</legend>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {options.map((option) => {
            const selected = value === option.id;
            return (
              <label
                key={option.id}
                className={`flex min-w-0 cursor-pointer flex-col gap-2 rounded-xl border border-border-token p-3 focus-within:ring-2 focus-within:ring-accent ${selected ? 'tile-selected' : ''}`}
              >
                {option.imageId ? (
                  <ProductImage imageId={option.imageId} alt="" slug={slug} />
                ) : (
                  <span
                    aria-hidden="true"
                    data-swatch={option.hex || ''}
                    className="block aspect-[3/2] rounded-lg border border-border-token"
                    style={option.hex ? { backgroundColor: option.hex } : undefined}
                  />
                )}
                <span className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={name}
                    value={option.id}
                    checked={selected}
                    onChange={() => onChange(option.id)}
                  />
                  {option.name}
                </span>
                {priceOf?.(option.id) && <span className="text-sm">{priceOf(option.id)}</span>}
              </label>
            );
          })}
        </div>
      </fieldset>
    );
  }
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
