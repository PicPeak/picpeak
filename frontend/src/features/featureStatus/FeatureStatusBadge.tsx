import React from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, type BadgeTone } from '../../components/common/Badge';
import type { FeatureKey } from '../../services/featureFlags.service';
import { featureState, type FeatureState, type PortalFeatureKey } from './registry';

const TONE: Record<Exclude<FeatureState, 'stable'>, BadgeTone> = {
  new: 'success',
  beta: 'warning',
  experimental: 'danger',
  roadmap: 'neutral',
};

/** The label and its one-line meaning, for the badge and its tooltip. */
export function useFeatureStateText() {
  const { t } = useTranslation();
  return (state: Exclude<FeatureState, 'stable'>) => ({
    label: {
      new: t('settings.features.status.new', 'new'),
      beta: t('settings.features.status.beta', 'beta'),
      experimental: t('settings.features.status.experimental', 'experimental'),
      roadmap: t('settings.features.status.roadmap', 'roadmap'),
    }[state],
    meaning: {
      new: t('settings.features.statusHelp.new', 'Recently released and ready to use.'),
      beta: t('settings.features.statusHelp.beta', 'In development: ready for real work, but details may still change.'),
      experimental: t('settings.features.statusHelp.experimental', 'May break or be removed. Not for a production studio.'),
      roadmap: t('settings.features.statusHelp.roadmap', 'Not built yet.'),
    }[state],
  });
}

interface FeatureStatusBadgeProps {
  feature: FeatureKey | PortalFeatureKey;
  className?: string;
}

/**
 * The feature-state label (registry.ts). Renders nothing for a stable
 * feature. Used on the Features page, in SectionPageHeader and on the
 * customer record's portal tabs — never in the sidebar.
 */
export const FeatureStatusBadge: React.FC<FeatureStatusBadgeProps> = ({ feature, className }) => {
  const text = useFeatureStateText();
  const state = featureState(feature);
  if (state === 'stable') return null;
  const { label, meaning } = text(state);
  return (
    <Badge
      caps
      tone={TONE[state]}
      appearance={state === 'roadmap' ? 'outline' : 'soft'}
      title={meaning}
      className={className}
    >
      {label}
    </Badge>
  );
};
