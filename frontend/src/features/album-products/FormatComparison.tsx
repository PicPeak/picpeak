import { availableOptions, type ConfigurationValues } from './ConfigurationPicker';
import type { Attribute, Option } from './model';

const MILLIMETRES = { mm: 1, cm: 10, in: 25.4 };
const inMillimetres = (option: Option, side: 'width' | 'height') =>
  (option[side] || 0) * MILLIMETRES[option.unit || 'cm'];

/** The sizes the format offers, smallest first. */
export function sizesOf(format: Option, formatAttribute: Attribute, size: Attribute) {
  const values: ConfigurationValues = { [formatAttribute.id]: [format.id] };
  return [...availableOptions(size, values)].sort(
    (a, b) => inMillimetres(a, 'width') - inMillimetres(b, 'width'),
  );
}

/**
 * One size drawn to its true ratio, at a scale shared by everything drawn next
 * to it: `largest` is the widest side in view, so the outlines compare.
 */
export function SizeOutline({
  size,
  largest,
  spread = false,
}: {
  size: Option;
  largest: number;
  spread?: boolean;
}) {
  const width = inMillimetres(size, 'width');
  const height = inMillimetres(size, 'height');
  return (
    <span
      aria-hidden="true"
      data-ratio={`${width}:${height}`}
      className="relative mx-auto block rounded-sm border-2 border-current"
      style={{ width: `${(width / largest) * 100}%`, aspectRatio: `${width} / ${height}` }}
    >
      {spread && <span className="absolute inset-y-0 left-1/2 border-l border-dashed border-current" />}
    </span>
  );
}

export const widestOf = (sizes: Option[]) =>
  Math.max(1, ...sizes.map((s) => inMillimetres(s, 'width')));

/** The format step: every format side by side, largest size to true ratio. */
export function FormatComparison({
  format,
  size,
  value,
  onChange,
  name,
  disabled = false,
}: {
  format: Attribute;
  size: Attribute;
  value?: string;
  onChange: (id: string) => void;
  name: string;
  disabled?: boolean;
}) {
  const largest = widestOf(size.options);
  return (
    <fieldset disabled={disabled}>
      <legend className="sr-only">{format.name}</legend>
      <div className="grid grid-cols-2 gap-3">
        {format.options.map((option) => {
          const sizes = sizesOf(option, format, size);
          const widest = sizes[sizes.length - 1];
          const selected = value === option.id;
          return (
            <label
              key={option.id}
              className={`flex min-w-0 cursor-pointer flex-col gap-3 rounded-xl border border-border-token p-3 focus-within:ring-2 focus-within:ring-accent ${selected ? 'tile-selected' : ''}`}
            >
              <span className="flex h-28 items-center">
                <span className="w-full">
                  {widest && <SizeOutline size={widest} largest={largest} spread={size.spread} />}
                </span>
              </span>
              <span className="flex items-start gap-2">
                <input
                  type="radio"
                  name={name}
                  value={option.id}
                  checked={selected}
                  onChange={() => onChange(option.id)}
                />
                <span className="min-w-0">
                  <span className="block font-semibold">{option.name}</span>
                  {sizes.map((s) => (
                    <span key={s.id} className="block text-sm">
                      {s.name}
                    </span>
                  ))}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
