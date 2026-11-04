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

export type Bounds = { width: number; height: number };
/** The widest and the tallest side in view: the box every outline shares. */
export const boundsOf = (sizes: Option[]): Bounds => ({
  width: Math.max(1, ...sizes.map((s) => inMillimetres(s, 'width'))),
  height: Math.max(1, ...sizes.map((s) => inMillimetres(s, 'height'))),
});

/**
 * One size drawn to its true ratio, at a scale shared by everything drawn next
 * to it (issue 2397): every outline is drawn in millimetres inside the same
 * `bounds`, and the SVG fits that box into its container, so the largest
 * format fills the space, a square stays square and the others compare.
 */
export function SizeOutline({
  size,
  bounds,
  spread = false,
}: {
  size: Option;
  bounds: Bounds;
  spread?: boolean;
}) {
  const width = inMillimetres(size, 'width');
  const height = inMillimetres(size, 'height');
  const x = (bounds.width - width) / 2;
  const y = (bounds.height - height) / 2;
  return (
    <svg
      aria-hidden="true"
      data-ratio={`${width}:${height}`}
      viewBox={`0 0 ${bounds.width} ${bounds.height}`}
      preserveAspectRatio="xMidYMid meet"
      className="block h-full w-full overflow-visible"
    >
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
      />
      {spread && (
        <line
          x1={bounds.width / 2}
          x2={bounds.width / 2}
          y1={y}
          y2={y + height}
          stroke="currentColor"
          strokeWidth={1}
          strokeDasharray="4 3"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}

/** The format step: every format side by side, largest size to true ratio. */
export function FormatComparison({
  format,
  size,
  value,
  onChange,
  name,
  disabled = false,
  priceOf,
}: {
  format: Attribute;
  size: Attribute;
  value?: string;
  onChange: (id: string) => void;
  name: string;
  disabled?: boolean;
  priceOf?: (optionId: string) => string | null;
}) {
  const widest = format.options.map((option) => sizesOf(option, format, size).at(-1));
  const bounds = boundsOf(widest.filter((s): s is Option => !!s));
  return (
    <fieldset disabled={disabled}>
      <legend className="sr-only">{format.name}</legend>
      <div className="grid grid-cols-2 gap-3">
        {format.options.map((option, index) => {
          const sizes = sizesOf(option, format, size);
          const shape = widest[index];
          const selected = value === option.id;
          return (
            <label
              key={option.id}
              className={`flex min-w-0 cursor-pointer flex-col gap-3 rounded-xl border border-border-token p-3 focus-within:ring-2 focus-within:ring-accent ${selected ? 'tile-selected' : ''}`}
            >
              <span className="block h-32 p-1 sm:h-40">
                {shape && <SizeOutline size={shape} bounds={bounds} spread={size.spread} />}
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
                  {priceOf?.(option.id) && <span className="block text-sm">{priceOf(option.id)}</span>}
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
