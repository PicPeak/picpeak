import React from 'react';
import { Grid3x3, Grid2x2, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../common';
import {
  GRID_DENSITIES,
  layoutHasDensity,
  setGridDensity,
  useChosenGridDensity,
  type GridDensity,
} from './gridDensity';

const ICONS: Record<GridDensity, React.ComponentType<{ className?: string }>> = {
  compact: Grid3x3,
  default: Grid2x2,
  large: Square,
};

/**
 * The viewer's tile-size switch for the gallery toolbar (issue 1733, E4).
 * Renders nothing for a layout where tile size has no meaning.
 */
export const GridDensityControl: React.FC<{ layout?: string }> = ({ layout }) => {
  const { t } = useTranslation();
  const density = useChosenGridDensity();
  if (!layoutHasDensity(layout)) return null;

  return (
    <div role="group" aria-label={t('gallery.density.label', 'Tile size')} className="flex items-center gap-1 flex-shrink-0">
      {GRID_DENSITIES.map((option) => {
        const Icon = ICONS[option];
        const label = t(`gallery.density.${option}`);
        return (
          <Button
            key={option}
            variant={density === option ? 'primary' : 'outline'}
            size="icon-md"
            onClick={() => setGridDensity(option)}
            aria-label={label}
            aria-pressed={density === option}
            title={label}
          >
            <Icon className="w-4 h-4" />
          </Button>
        );
      })}
    </div>
  );
};
