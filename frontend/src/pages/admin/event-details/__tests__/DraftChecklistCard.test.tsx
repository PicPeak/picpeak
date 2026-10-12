/**
 * The "Before you share" card on a draft gallery's overview (issue 1733):
 * its rows are read from the event the page already holds, each links to
 * where the step is done, and a published gallery has no card.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

import { DraftChecklistCard } from '../DraftChecklistCard';
import type { Event } from '../../../../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown, opts?: Record<string, unknown>) =>
      (typeof fallback === 'string'
        ? fallback.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(opts?.[name]))
        : key),
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

const setActiveTab = vi.fn();
const openSettings = vi.fn();
const onPublish = vi.fn();

const renderCard = (over: Record<string, unknown>, canPublish = true) => render(
  <DraftChecklistCard
    event={{ id: 3, event_name: 'Wedding', is_draft: true, photo_count: 0, customer_email: '', ...over } as unknown as Event}
    setActiveTab={setActiveTab}
    openSettings={openSettings}
    onPublish={canPublish ? onPublish : undefined}
  />,
);

const row = (key: string) => within(screen.getByTestId(`next-step-${key}`));

describe('DraftChecklistCard', () => {
  it('lists what is still to do on an empty draft, each row linking to its place', () => {
    renderCard({});
    expect(screen.getByText('0 of 3 done')).toBeInTheDocument();
    expect(row('photos').getByText('To do')).toBeInTheDocument();
    expect(row('customer').getByText('To do')).toBeInTheDocument();
    expect(row('publish').getByText('To do')).toBeInTheDocument();

    fireEvent.click(row('photos').getByRole('button', { name: 'Open Photos' }));
    expect(setActiveTab).toHaveBeenCalledWith('photos');
    fireEvent.click(row('customer').getByRole('button', { name: 'Open Settings' }));
    expect(openSettings).toHaveBeenCalledWith('general');
    fireEvent.click(row('publish').getByRole('button', { name: 'Publish' }));
    expect(onPublish).toHaveBeenCalledTimes(1);
  });

  it('marks photos and the customer as done from the event data', () => {
    renderCard({ photo_count: 12, customer_email: 'sarah@example.com' });
    expect(screen.getByText('2 of 3 done')).toBeInTheDocument();
    expect(row('photos').getByText('Done')).toBeInTheDocument();
    expect(row('customer').getByText('Done')).toBeInTheDocument();
    expect(row('publish').getByText('To do')).toBeInTheDocument();
  });

  it('counts an assigned customer account as the customer, listed or only counted', () => {
    const { unmount } = renderCard({ customer_accounts: [{ id: 11, email: 'nico@example.com' }] });
    expect(row('customer').getByText('Done')).toBeInTheDocument();
    unmount();
    // Without customers.view the route sends the count, not the list.
    renderCard({ gallery_notice: { account_count: 1, folds_inline: false } });
    expect(row('customer').getByText('Done')).toBeInTheDocument();
  });

  it('offers no Publish link to an admin who may not publish', () => {
    renderCard({}, false);
    expect(row('publish').queryByRole('button')).toBeNull();
  });

  it('is absent once the gallery is published, and on an archived draft', () => {
    const published = renderCard({ is_draft: false });
    expect(published.container).toBeEmptyDOMElement();
    published.unmount();
    // SQLite sends integer booleans.
    const publishedInt = renderCard({ is_draft: 0 });
    expect(publishedInt.container).toBeEmptyDOMElement();
    publishedInt.unmount();
    expect(renderCard({ is_archived: true }).container).toBeEmptyDOMElement();
  });
});
