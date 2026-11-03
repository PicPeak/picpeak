/**
 * Clients → Gifts (migration 343).
 *
 * Who a gift is due for, who missed a milestone and why, what is in stock, and
 * the rules behind the lists. Nothing here happens on its own: an admin
 * confirms or declines every gift.
 */
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Gift, History, Plus } from 'lucide-react';

import {
  Badge, Button, Card, EmptyState, ErrorState, Input, Loading, Modal, Notice,
} from '../../../components/common';
import { SectionPageHeader } from '../../../components/admin/SectionPageHeader';
import {
  AddStockModal, CorrectStockModal, DeclineGiftModal, GiveGiftModal,
} from '../../../components/admin/GiftDialogs';
import { useMutationWithToast } from '../../../hooks';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';
import { usePermissions } from '../../../contexts/PermissionsContext';
import {
  giftsService, type GiftItem, type GiftRules, type GiftSuggestion,
} from '../../../services/gifts.service';
import { formatMoneyMinor } from '../../../utils/money';

type Dialog =
  | { type: 'give'; suggestion: GiftSuggestion; override: boolean }
  | { type: 'decline'; suggestion: GiftSuggestion };

function reasonText(t: TFunction, row: GiftSuggestion, rules: GiftRules | undefined, date: string): string {
  if (row.reason === 'too_few_bookings') {
    return t('gifts.reason.bookings', '{{have}} of {{need}} bookings', {
      have: row.bookingCount, need: rules?.minBookings ?? 3,
    });
  }
  return date
    ? t('gifts.reason.lastPayment', 'Last payment {{date}}', { date })
    : t('gifts.reason.noPayment', 'No payment yet');
}

const NOT_QUALIFIED_PAGE = 25;

const SuggestionList: React.FC<{
  rows: GiftSuggestion[];
  rules?: GiftRules;
  canManage: boolean;
  giveLabel: string;
  onGive: (row: GiftSuggestion) => void;
  onDecline: (row: GiftSuggestion) => void;
}> = ({ rows, rules, canManage, giveLabel, onGive, onDecline }) => {
  const { t } = useTranslation();
  const { format } = useLocalizedDate();
  return (
    <ul className="divide-y divide-line">
      {rows.map((row) => (
        <li key={row.customerId} className="py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-heading flex flex-wrap items-center gap-2">
              <Link to={`/admin/clients/accounts/${row.customerId}`} className="hover:underline">{row.customerName}</Link>
              <Badge>{t('gifts.milestoneBadge', { count: row.milestoneYears, defaultValue_one: '{{count}} year', defaultValue_other: '{{count}} years' })}</Badge>
            </p>
            <p className="text-xs text-soft">
              {format(row.milestoneDate)}
              {row.reason ? ` · ${reasonText(t, row, rules, row.lastPaidOn ? format(row.lastPaidOn) : '')}` : ''}
            </p>
          </div>
          {canManage && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => onDecline(row)}>{t('gifts.decline.submit', 'Decline')}</Button>
              <Button size="sm" onClick={() => onGive(row)}>{giveLabel}</Button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
};

const ItemHistory: React.FC<{ item: GiftItem | null; onClose: () => void }> = ({ item, onClose }) => {
  const { t } = useTranslation();
  const { format } = useLocalizedDate();
  const { data: movements = [], isError, isFetching, refetch } = useQuery({
    queryKey: ['admin-gift-movements', item?.id],
    queryFn: () => giftsService.listMovements((item as GiftItem).id),
    enabled: !!item,
  });
  const kindLabel = {
    purchase: t('gifts.movement.purchase', 'Purchase'),
    gift: t('gifts.movement.gift', 'Gift'),
    gift_undone: t('gifts.movement.giftUndone', 'Gift undone'),
    correction: t('gifts.movement.correction', 'Correction'),
  };
  return (
    <Modal open={!!item} onClose={onClose} title={t('gifts.stock.historyTitle', 'Stock history')} description={item?.name}>
      {isError && <ErrorState size="inline" onRetry={() => refetch()} retrying={isFetching} />}
      {!isError && !isFetching && movements.length === 0 && (
        <EmptyState size="inline" title={t('gifts.stock.historyEmpty', 'No stock changes yet')} />
      )}
      <ul className="divide-y divide-line">
        {movements.map((movement) => (
          <li key={movement.id} className="py-2 flex items-start justify-between gap-3 text-sm">
            <div className="min-w-0">
              <p className="text-heading">{kindLabel[movement.kind]}</p>
              <p className="text-xs text-soft">
                {[
                  format(movement.occurredOn),
                  movement.unitCostMinor !== null
                    ? formatMoneyMinor(movement.unitCostMinor, movement.currency || 'CHF')
                    : null,
                  movement.reason,
                ].filter(Boolean).join(' · ')}
              </p>
            </div>
            <span className="font-medium text-heading tabular-nums">
              {movement.quantityDelta > 0 ? `+${movement.quantityDelta}` : movement.quantityDelta}
            </span>
          </li>
        ))}
      </ul>
    </Modal>
  );
};

const RULE_FIELDS: Array<{ key: Exclude<keyof GiftRules, 'milestoneYears'>; min: number }> = [
  { key: 'minBookings', min: 0 },
  { key: 'activityMinInvoices', min: 0 },
  { key: 'activityPeriodYears', min: 1 },
  { key: 'rhythmMarginMonths', min: 0 },
  { key: 'graceDays', min: 0 },
];

const RulesCard: React.FC<{ rules: GiftRules; canManage: boolean }> = ({ rules, canManage }) => {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(rules);
  const [milestones, setMilestones] = useState(rules.milestoneYears.join(', '));

  useEffect(() => {
    setDraft(rules);
    setMilestones(rules.milestoneYears.join(', '));
  }, [rules]);

  const parsedMilestones = milestones.split(/[,\s]+/).filter(Boolean).map(Number);
  const milestonesValid = parsedMilestones.length > 0
    && parsedMilestones.every((value) => Number.isInteger(value) && value >= 1 && value <= 100);

  const labels: Record<(typeof RULE_FIELDS)[number]['key'], string> = {
    minBookings: t('gifts.rules.minBookings', 'Minimum paid bookings'),
    activityMinInvoices: t('gifts.rules.activityMinBookings', 'Active: minimum paid bookings'),
    activityPeriodYears: t('gifts.rules.activityPeriodYears', 'Active: within this many years'),
    rhythmMarginMonths: t('gifts.rules.rhythmMarginMonths', 'Booking rhythm margin (months)'),
    graceDays: t('gifts.rules.graceDays', 'Grace period (days)'),
  };

  const save = useMutationWithToast({
    // Only what changed, so a default nobody touched stays a default.
    mutationFn: () => giftsService.updateRules({
      ...Object.fromEntries(RULE_FIELDS.filter(({ key }) => draft[key] !== rules[key]).map(({ key }) => [key, draft[key]])),
      ...(parsedMilestones.join() === rules.milestoneYears.join() ? {} : { milestoneYears: parsedMilestones }),
    }),
    successMessage: t('gifts.rules.saved', 'Rules saved'),
    invalidateKeys: [['admin-gift-rules'], ['admin-gift-suggestions']],
  });

  return (
    <Card padding="lg">
      <h2 className="text-lg font-semibold text-heading mb-1">{t('gifts.rules.title', 'Rules')}</h2>
      <p className="text-sm text-soft mb-4">
        {t('gifts.rules.hint', 'A customer also stays active if their last payment fits their usual gap between bookings.')}
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label htmlFor="gift-rule-milestones" className="block text-sm font-medium text-heading mb-1">
            {t('gifts.rules.milestones', 'Milestones (years)')}
          </label>
          <Input
            id="gift-rule-milestones"
            value={milestones}
            disabled={!canManage}
            onChange={(e) => setMilestones(e.target.value)}
          />
        </div>
        {RULE_FIELDS.map(({ key, min }) => (
          <div key={key}>
            <label htmlFor={`gift-rule-${key}`} className="block text-sm font-medium text-heading mb-1">{labels[key]}</label>
            <Input
              id={`gift-rule-${key}`}
              type="number"
              min={min}
              disabled={!canManage}
              value={draft[key]}
              onChange={(e) => setDraft({ ...draft, [key]: Math.max(min, Math.floor(Number(e.target.value) || 0)) })}
            />
          </div>
        ))}
      </div>
      {canManage && (
        <div className="mt-4">
          <Button onClick={() => save.mutate()} disabled={!milestonesValid || save.isPending}>{t('common.save', 'Save')}</Button>
        </div>
      )}
    </Card>
  );
};

export const GiftsPage: React.FC = () => {
  const { t } = useTranslation();
  const { hasPermission } = usePermissions();
  const canManage = hasPermission('customers.gifts.manage');
  const canSeeCustomers = hasPermission('customers.view');

  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [addingStock, setAddingStock] = useState<GiftItem | null>(null);
  const [correcting, setCorrecting] = useState<GiftItem | null>(null);
  const [history, setHistory] = useState<GiftItem | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [notQualifiedShown, setNotQualifiedShown] = useState(NOT_QUALIFIED_PAGE);

  const suggestions = useQuery({
    queryKey: ['admin-gift-suggestions'],
    queryFn: giftsService.listSuggestions,
    enabled: canSeeCustomers,
  });
  const items = useQuery({ queryKey: ['admin-gift-items', true], queryFn: () => giftsService.listItems(true) });
  const rules = useQuery({ queryKey: ['admin-gift-rules'], queryFn: giftsService.getRules });

  const create = useMutationWithToast({
    mutationFn: () => giftsService.createItem({ name: name.trim() }),
    successMessage: t('gifts.items.created', 'Item created'),
    invalidateKeys: [['admin-gift-items']],
    onSuccess: () => { setCreating(false); setName(''); },
  });

  const archive = useMutationWithToast({
    mutationFn: (item: GiftItem) => giftsService.updateItem(item.id, { isArchived: !item.isArchived }),
    invalidateKeys: [['admin-gift-items']],
  });

  const due = suggestions.data?.due || [];
  const notQualified = suggestions.data?.notQualified || [];
  const activeItems = (items.data || []).filter((item) => !item.isArchived);
  const inStock = activeItems.reduce((sum, item) => sum + Math.max(item.stock, 0), 0);
  const shortBy = due.length - inStock;

  return (
    <div className="space-y-6">
      <SectionPageHeader
        title={t('gifts.title', 'Gifts')}
        description={t('gifts.subtitle', 'Thank loyal customers at their milestones and keep track of gift stock.')}
        icon={Gift}
        feature="customerGifts"
      />

      {shortBy > 0 && (
        <Notice tone="warning">
          {t('gifts.lowStock', {
            count: due.length,
            stock: inStock,
            defaultValue_one: '{{count}} gift due, {{stock}} in stock.',
            defaultValue_other: '{{count}} gifts due, {{stock}} in stock.',
          })}
        </Notice>
      )}

      {canSeeCustomers && (
      <Card padding="lg">
        <h2 className="text-lg font-semibold text-heading mb-2">{t('gifts.due.title', 'Gifts due')}</h2>
        {suggestions.isLoading && <Loading />}
        {suggestions.isError && <ErrorState size="inline" onRetry={() => suggestions.refetch()} />}
        {suggestions.data && due.length === 0 && (
          <EmptyState size="inline" title={t('gifts.due.empty', 'No gifts due right now')} />
        )}
        <SuggestionList
          rows={due}
          rules={rules.data}
          canManage={canManage}
          giveLabel={t('gifts.due.confirm', 'Confirm gift')}
          onGive={(suggestion) => setDialog({ type: 'give', suggestion, override: false })}
          onDecline={(suggestion) => setDialog({ type: 'decline', suggestion })}
        />
      </Card>
      )}

      {notQualified.length > 0 && (
        <Card padding="lg">
          <h2 className="text-lg font-semibold text-heading mb-1">{t('gifts.notQualified.title', "Didn't qualify")}</h2>
          <p className="text-sm text-soft mb-2">
            {t('gifts.notQualified.hint', 'Past the grace period. You can still give a gift, and it is marked as an override.')}
          </p>
          <SuggestionList
            rows={notQualified.slice(0, notQualifiedShown)}
            rules={rules.data}
            canManage={canManage}
            giveLabel={t('gifts.notQualified.override', 'Gift anyway')}
            onGive={(suggestion) => setDialog({ type: 'give', suggestion, override: true })}
            onDecline={(suggestion) => setDialog({ type: 'decline', suggestion })}
          />
          {notQualified.length > notQualifiedShown && (
            <Button
              className="mt-2"
              size="sm"
              variant="ghost"
              onClick={() => setNotQualifiedShown(notQualifiedShown + NOT_QUALIFIED_PAGE)}
            >
              {t('gifts.notQualified.showMore', 'Show more ({{count}} left)', { count: notQualified.length - notQualifiedShown })}
            </Button>
          )}
        </Card>
      )}

      <Card padding="lg">
        <div className="flex items-center justify-between gap-4 mb-2 flex-wrap">
          <h2 className="text-lg font-semibold text-heading">{t('gifts.items.title', 'Stock')}</h2>
          {canManage && (
            <Button variant="outline" size="sm" leftIcon={<Plus className="w-4 h-4" />} onClick={() => setCreating(true)}>
              {t('gifts.items.add', 'New item')}
            </Button>
          )}
        </div>
        {items.isError && <ErrorState size="inline" onRetry={() => items.refetch()} />}
        {items.data && items.data.length === 0 && (
          <EmptyState size="inline" title={t('gifts.items.empty', 'No gift items yet')} />
        )}
        <ul className="divide-y divide-line">
          {(items.data || []).map((item) => (
            <li key={item.id} className="py-3 flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-heading flex flex-wrap items-center gap-2">
                  {item.name}
                  {item.isArchived && <Badge>{t('gifts.items.archived', 'Archived')}</Badge>}
                </p>
                <p className="text-xs text-soft">
                  {t('gifts.items.stock', '{{count}} in stock', { count: item.stock })}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="ghost" leftIcon={<History className="w-4 h-4" />} onClick={() => setHistory(item)}>
                  {t('gifts.items.history', 'History')}
                </Button>
                {canManage && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => archive.mutate(item)}>
                      {item.isArchived ? t('gifts.items.restore', 'Restore') : t('gifts.items.archive', 'Archive')}
                    </Button>
                    {!item.isArchived && (
                      <>
                        <Button size="sm" variant="outline" onClick={() => setCorrecting(item)}>
                          {t('gifts.stock.correctTitle', 'Correct stock')}
                        </Button>
                        <Button size="sm" onClick={() => setAddingStock(item)}>{t('gifts.stock.addTitle', 'Add stock')}</Button>
                      </>
                    )}
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      </Card>

      {rules.data && <RulesCard rules={rules.data} canManage={canManage} />}

      <GiveGiftModal
        open={dialog?.type === 'give'}
        onClose={() => setDialog(null)}
        customerId={dialog?.suggestion.customerId ?? 0}
        customerName={dialog?.suggestion.customerName}
        milestoneYears={dialog?.suggestion.milestoneYears}
        isOverride={dialog?.type === 'give' && dialog.override}
      />
      {dialog?.type === 'decline' && (
        <DeclineGiftModal
          open
          onClose={() => setDialog(null)}
          customerId={dialog.suggestion.customerId}
          customerName={dialog.suggestion.customerName}
          milestoneYears={dialog.suggestion.milestoneYears}
        />
      )}
      <AddStockModal item={addingStock} onClose={() => setAddingStock(null)} />
      <CorrectStockModal item={correcting} onClose={() => setCorrecting(null)} />
      <ItemHistory item={history} onClose={() => setHistory(null)} />

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        size="sm"
        title={t('gifts.items.add', 'New item')}
        footer={(
          <>
            <Button variant="outline" onClick={() => setCreating(false)}>{t('common.cancel', 'Cancel')}</Button>
            <Button onClick={() => create.mutate()} disabled={!name.trim() || create.isPending}>
              {t('gifts.items.create', 'Create')}
            </Button>
          </>
        )}
      >
        <label htmlFor="gift-item-name" className="block text-sm font-medium text-heading mb-1">
          {t('gifts.items.name', 'Name')}
        </label>
        <Input id="gift-item-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
      </Modal>
    </div>
  );
};

export default GiftsPage;
