/**
 * What is left to do before a draft gallery is shared (issue 1733). Each row
 * is read from the event the page already holds and links to where the step
 * is done. Nothing is stored: the card goes away once the gallery is
 * published.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Circle } from 'lucide-react';
import type { Event } from '../../../types';
import { Badge, Card } from '../../../components/common';
import { toBoolean } from '../../../utils/parsers';
import type { EventDetailsTab } from './types';
import type { SettingsSectionKey } from './settings/draft';

interface DraftChecklistCardProps {
  event: Event;
  setActiveTab: (tab: EventDetailsTab) => void;
  openSettings: (section: SettingsSectionKey) => void;
  /** Opens the publish dialog; left out when this admin may not publish. */
  onPublish?: () => void;
}

/**
 * Whether the gallery has someone to send it to: a customer email, or an
 * assigned account a gallery notice reaches. That is the server's count
 * (`gallery_notice`: active, can sign in, portal on), which every admin gets;
 * the assigned list is customers.view data and also holds inactive and
 * passive accounts, so counting it would show two admins different progress.
 */
function hasCustomer(event: Event): boolean {
  const notice = (event as { gallery_notice?: { account_count?: number } | null }).gallery_notice;
  return !!event.customer_email?.trim() || (notice?.account_count ?? 0) > 0;
}

export const DraftChecklistCard: React.FC<DraftChecklistCardProps> = ({ event, setActiveTab, openSettings, onPublish }) => {
  const { t } = useTranslation();
  if (!toBoolean(event.is_draft, false) || toBoolean(event.is_archived, false)) return null;

  const steps: Array<{ key: string; label: string; done: boolean; linkLabel: string; onOpen?: () => void }> = [
    {
      key: 'photos',
      label: t('events.nextSteps.photos', 'Add photos'),
      done: Number(event.photo_count) > 0,
      linkLabel: t('events.nextSteps.photosLink', 'Open Photos'),
      onOpen: () => setActiveTab('photos'),
    },
    {
      key: 'customer',
      label: t('events.nextSteps.customer', 'Add a customer email or account'),
      done: hasCustomer(event),
      linkLabel: t('events.nextSteps.customerLink', 'Open Settings'),
      onOpen: () => openSettings('general'),
    },
    {
      key: 'publish',
      label: t('events.nextSteps.publish', 'Publish the gallery'),
      done: false,
      linkLabel: t('events.nextSteps.publishLink', 'Publish'),
      onOpen: onPublish,
    },
  ];

  return (
    <Card padding="md">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 mb-2">
        <h2 className="text-lg font-semibold text-heading">{t('events.nextSteps.title', 'Before you share')}</h2>
        <span className="text-xs text-muted">
          {t('events.nextSteps.progress', '{{done}} of {{total}} done', { done: steps.filter((s) => s.done).length, total: steps.length })}
        </span>
      </div>
      <ul>
        {steps.map((step) => (
          <li
            key={step.key}
            data-testid={`next-step-${step.key}`}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 border-t border-line first:border-t-0"
          >
            {step.done
              ? <CheckCircle2 className="w-4 h-4 shrink-0 text-success-text" aria-hidden="true" />
              : <Circle className="w-4 h-4 shrink-0 text-faint" aria-hidden="true" />}
            <span className="flex-1 min-w-0 text-sm text-heading">{step.label}</span>
            <Badge tone={step.done ? 'success' : 'neutral'}>
              {step.done ? t('events.nextSteps.done', 'Done') : t('events.nextSteps.todo', 'To do')}
            </Badge>
            {step.onOpen && (
              <button type="button" className="text-sm font-medium text-accent hover:underline" onClick={step.onOpen}>
                {step.linkLabel}
              </button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
};
