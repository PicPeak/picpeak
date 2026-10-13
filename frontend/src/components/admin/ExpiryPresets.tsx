/**
 * Quick picks next to an expiry field: 30 / 60 / 90 days and, where the
 * caller can store it, "Never". The field itself stays; a pick only fills it,
 * and the pick that matches the field's value shows as chosen.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../common';

export const EXPIRY_PRESET_DAYS = [30, 60, 90] as const;

export type ExpiryPreset = number | 'never';

interface ExpiryPresetsProps {
  /** The pick the field's value equals now, or null when it matches none. */
  selected: ExpiryPreset | null;
  onSelect: (preset: ExpiryPreset) => void;
  /** Offer "Never". Only where an empty expiry is stored as such. */
  allowNever?: boolean;
  /** Short text in front of the picks, saying what the days count from. */
  lead?: string;
}

export const ExpiryPresets: React.FC<ExpiryPresetsProps> = ({ selected, onSelect, allowNever = false, lead }) => {
  const { t } = useTranslation();
  const pick = (preset: ExpiryPreset, label: string) => (
    <Button
      key={preset}
      type="button"
      variant="outline"
      size="sm"
      aria-pressed={selected === preset}
      className={selected === preset ? 'tile-selected' : undefined}
      onClick={() => onSelect(preset)}
    >
      {label}
    </Button>
  );
  return (
    <div
      role="group"
      aria-label={t('events.expiryPresets.label', 'Expiry quick picks')}
      className="flex flex-wrap items-center gap-2"
    >
      {lead && <span className="text-xs text-muted">{lead}</span>}
      {EXPIRY_PRESET_DAYS.map((days) => pick(days, t('events.expiryPresets.days', '{{days}} days', { days })))}
      {allowNever && pick('never', t('events.neverExpires', 'Never'))}
    </div>
  );
};
