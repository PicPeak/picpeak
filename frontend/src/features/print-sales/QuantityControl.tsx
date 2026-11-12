import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { validQuantity } from './shopping';
export function QuantityControl({ value, onChange, onValidity, label }: {
  value: number; onChange: (value: number) => void; onValidity: (valid: boolean) => void; label: string;
}) {
  const { t } = useTranslation(), [text, setText] = useState(String(value)), id = useId();
  const validity = useRef(onValidity); validity.current = onValidity;
  useEffect(() => { setText(String(value)); validity.current(true); }, [value]);
  const valid = text.trim() !== '' && validQuantity(Number(text));
  function step(delta: number) {
    const next = Math.min(100, Math.max(1, (valid ? Number(text) : value) + delta));
    setText(String(next)); onValidity(true); onChange(next);
  }
  return <div><div className="print-quantity">
    <button type="button" aria-label={`${t('printSales.fewer', 'Fewer copies')}: ${label}`} disabled={value <= 1} onClick={() => step(-1)}>−</button>
    <input aria-label={label} type="number" inputMode="numeric" min={1} max={100} step={1} value={text} aria-invalid={!valid}
      aria-describedby={!valid ? id : undefined} onChange={e => {
        const next = e.target.value, acceptable = next.trim() !== '' && validQuantity(Number(next));
        setText(next); onValidity(acceptable); if (acceptable) onChange(Number(next));
      }} onBlur={() => { setText(String(value)); onValidity(true); }} />
    <button type="button" aria-label={`${t('printSales.more', 'More copies')}: ${label}`} disabled={value >= 100} onClick={() => step(1)}>+</button>
  </div>{!valid && <p id={id} role="status" className="text-sm text-warning-text">{t('printSales.validCopies', 'Enter a whole number from 1 to 100.')}</p>}</div>;
}
