/**
 * "Add-ons at acceptance" on the quote detail page (#1451). Shows which
 * add-ons the accepted quote books. Until a contract, event or invoice
 * exists the admin can book or remove them — e.g. after the customer called —
 * and save; the server stores a new PDF and always emails the customer the
 * updated quote. Below, every change made after the first acceptance.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { Button, Card, useConfirm } from '../../../components/common';
import { AddOnBookButton, AddOnBookingState } from '../../../components/common/AddOnBookButton';
import { PermissionGate } from '../../../components/admin/PermissionGate';
import { quotesService, type QuoteDetail, type QuoteLineItem, type ProductConfiguration } from '../../../services/quotes.service';
import { ConfigurationPicker, ChoiceSummary, attributeEnabled, choiceValues, type ConfigurationValues } from '../../../features/album-products/ConfigurationPicker';
import { formatMoneyMinor } from '../../../utils/money';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';

interface AddOnRow {
  position: number;
  description: string;
  detailsText: string | null;
  /** Null when only the acceptance snapshot knows the add-on. */
  lineTotalMinor: number | null;
  booked: boolean;
}

/** The offered add-ons: top-level optional lines, as on the PDF. */
function addOnRows(quote: QuoteDetail, lineItems: QuoteLineItem[]): AddOnRow[] {
  const fromLines = lineItems
    .filter((li) => li.isOptional && li.lineKind !== 'discount'
      && li.parentPosition == null && li.parentLineItemId == null)
    .map((li) => ({
      position: li.position,
      description: li.description,
      detailsText: li.detailsText && li.detailsText.trim() ? li.detailsText : null,
      lineTotalMinor: li.lineTotalMinor == null ? null : Number(li.lineTotalMinor),
      booked: li.selected !== false,
    }));
  if (fromLines.length > 0) return fromLines;
  return (quote.optionalSelection?.addOns || []).map((a) => ({
    position: a.position, description: a.description, detailsText: null, lineTotalMinor: null, booked: a.selected,
  }));
}

const errorCode = (err: unknown) =>
  (err as { response?: { data?: { code?: string } } })?.response?.data?.code;

const sorted = (positions: Iterable<number>) => [...positions].sort((a, b) => a - b);

export const QuoteAddOnsCard: React.FC<{ quote: QuoteDetail; lineItems: QuoteLineItem[] }> = ({ quote, lineItems }) => {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { formatDateTime: fmtDateTime } = useLocalizedDate();
  const qc = useQueryClient();
  const rows = addOnRows(quote, lineItems);
  const editable = quote.addOnsEditable === true && rows.length > 0;
  const converted = !editable && (quote.status === 'converted' || !!quote.convertedEventId || !!quote.convertedContractId);

  // The admin's unsaved choice, tied to the booking it started from: when the
  // quote changes underneath (a save, or the customer accepting again), the
  // stale draft is dropped instead of overwriting the new booking.
  const serverBooked = sorted(rows.filter((r) => r.booked).map((r) => r.position));
  const serverKey = JSON.stringify([serverBooked, lineItems.map((line) =>
    [line.id, line.configurationDefinition, line.configurationSnapshot])]);
  const [draft, setDraft] = useState<{
    base: string; positions: number[]; values: Record<number, ConfigurationValues>;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const activeDraft = draft && draft.base === serverKey ? draft : null;
  const chosen = new Set(activeDraft?.positions ?? serverBooked);
  const dirty = activeDraft !== null && activeDraft.positions.join(',') !== serverBooked.join(',');
  const topPosition = (line: QuoteLineItem) => line.parentPosition
    ?? lineItems.find((parent) => parent.id === line.parentLineItemId)?.position ?? line.position;
  const configurationLines = lineItems.filter((line) => line.configurationDefinition
    && rows.some((row) => row.position === topPosition(line)));
  const newLines = configurationLines.filter((line) => chosen.has(topPosition(line))
    && !serverBooked.includes(topPosition(line)));
  const valuesFor = (line: QuoteLineItem) => activeDraft?.values[line.position] ?? choiceValues(line.configurationSnapshot);
  const incomplete = newLines.some((line) => {
    const attributes = line.configurationDefinition!.product.attributes || [];
    const values = valuesFor(line);
    return attributes.some((attribute) => attribute.required && attributeEnabled(attribute, attributes, values)
      && !(values[attribute.id]?.length));
  });

  if (!quote.optionalSelection && !editable) return null;

  const toggle = (position: number) => {
    const next = new Set(chosen);
    if (next.has(position)) next.delete(position); else next.add(position);
    setDraft({ base: serverKey, positions: sorted(next), values: activeDraft?.values || {} });
  };

  const handleSave = async () => {
    if (!(await confirm({
      message: t('quotes.addOns.confirmSave', 'The customer will be emailed the updated quote.'),
      confirmLabel: t('quotes.addOns.save', 'Save add-on changes'),
    }))) return;
    setSaving(true);
    try {
      const configurations: ProductConfiguration[] = newLines.filter((line) => !line.configurationLocked).map((line) => ({
        position: line.position, definitionVersion: line.configurationDefinition!.version, values: valuesFor(line),
      }));
      const result = configurations.length
        ? await quotesService.changeAddOns(quote.id, sorted(chosen), configurations)
        : await quotesService.changeAddOns(quote.id, sorted(chosen));
      toast.success(result.changed
        ? t('quotes.addOns.savedToast', 'Add-ons updated. The customer has been emailed the updated quote.')
        : t('quotes.addOns.unchangedToast', 'The add-ons were already booked like this.'));
      setDraft(null);
    } catch (err: unknown) {
      const code = errorCode(err);
      toast.error(code === 'QUOTE_CONVERTED'
        ? t('quotes.addOns.errors.converted', 'This quote already has a contract, event or invoice. Change the add-ons there.')
        : code === 'QUOTE_NOT_ACCEPTED'
          ? t('quotes.addOns.errors.notAccepted', 'Add-ons can be changed here once the quote is accepted.')
          : code === 'NO_ADD_ONS'
            ? t('quotes.addOns.errors.noAddOns', 'This quote has no add-ons.')
            : t('quotes.addOns.errors.failed', 'The add-on changes could not be saved.'));
    } finally {
      setSaving(false);
      // Refresh either way: a refusal means the quote moved on (e.g. converted).
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['quote', String(quote.id)] }),
        qc.invalidateQueries({ queryKey: ['quotes'] }),
      ]);
    }
  };

  const changes = [...(quote.selectionChanges || [])].reverse();

  return (
    <Card>
      <h3 className="font-semibold mb-2 text-heading">{t('quotes.selection.title', 'Add-ons at acceptance')}</h3>
      {quote.selectionAcceptedAt && quote.optionalSelection && (
        <p className="text-sm text-body mb-2">
          {quote.optionalSelection.by === 'customer'
            ? t('quotes.selection.byCustomer', 'Chosen by the customer on {{date}}', { date: fmtDateTime(quote.selectionAcceptedAt) })
            : t('quotes.selection.byAdmin', 'Recorded when you accepted on {{date}}', { date: fmtDateTime(quote.selectionAcceptedAt) })}
        </p>
      )}
      {editable && (
        <PermissionGate permission="quotes.manage">
          <p className="text-sm text-body mb-2">
            {t('quotes.addOns.editHint', 'Book or remove add-ons, then save. The customer is emailed the updated quote.')}
          </p>
        </PermissionGate>
      )}
      {converted && (
        <p className="text-sm text-body mb-2">
          {t('quotes.addOns.convertedHint', 'Change the add-ons on the contract or invoice.')}
        </p>
      )}
      {chosen.size === 0 && (
        <p className="text-sm text-body mb-2">{t('quotes.selection.none', 'No add-ons chosen')}</p>
      )}
      <ul className="text-sm divide-y divide-line-faint">
        {rows.map((row) => {
          const booked = chosen.has(row.position);
          // A not-booked add-on is dimmed — except its Book button.
          const dim = booked ? '' : 'opacity-60';
          // Title, then details, then the status (with the button) as the last line.
          return (
            <li key={row.position} className="py-2">
              <div className={`flex items-start justify-between gap-4 ${dim}`}>
                <span className="text-heading">{row.description}</span>
                {row.lineTotalMinor != null && (
                  <span className="shrink-0 tabular-nums text-heading">
                    {formatMoneyMinor(row.lineTotalMinor, quote.currency)}
                  </span>
                )}
              </div>
              {booked && configurationLines.filter((line) => topPosition(line) === row.position).map((line) => (
                <div key={line.id} className="mt-3 rounded-lg border border-border-token p-3 space-y-3">
                  <p className="font-medium text-heading">{line.description}</p>
                  {editable && !row.booked && !line.configurationLocked ? (
                    <PermissionGate permission="quotes.manage">
                      <p className="text-xs text-muted">{t('products.addOnConfigurationHelp', 'Choose the specification for this new booking. Prices are recalculated when you save.')}</p>
                      <fieldset disabled={saving}>
                        <ConfigurationPicker product={line.configurationDefinition!.product} values={valuesFor(line)}
                          currency={quote.currency} surcharges={line.configurationDefinition!.surcharges}
                          onChange={(values) => setDraft({ base: serverKey, positions: sorted(chosen),
                            values: { ...activeDraft?.values, [line.position]: values } })} />
                      </fieldset>
                    </PermissionGate>
                  ) : line.configurationSnapshot ? <ChoiceSummary choice={line.configurationSnapshot} /> : null}
                </div>
              ))}
              {row.detailsText && (
                <p className={`mt-0.5 text-xs italic whitespace-pre-line text-muted ${dim}`}>
                  {row.detailsText}
                </p>
              )}
              <div className="mt-1 flex items-center gap-2 flex-wrap text-xs">
                {editable ? (
                  <>
                    <span className={`italic text-muted ${dim}`}>
                      <AddOnBookingState booked={booked} />
                    </span>
                    <PermissionGate permission="quotes.manage">
                      <AddOnBookButton booked={booked} disabled={saving} onToggle={() => toggle(row.position)} />
                    </PermissionGate>
                  </>
                ) : (
                  <span className={booked ? 'text-success-text' : 'text-muted'}>
                    {booked ? t('quotes.selection.chosen', 'Booked') : t('quotes.selection.notChosen', 'Not booked')}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {editable && (
        <PermissionGate permission="quotes.manage">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end mt-3">
            {incomplete && <p className="text-sm text-muted">{t('products.completeChoices', 'Complete the product choices to confirm your total.')}</p>}
            <Button size="sm" onClick={handleSave} disabled={!dirty || saving || incomplete}>
              {t('quotes.addOns.save', 'Save add-on changes')}
            </Button>
          </div>
        </PermissionGate>
      )}
      {changes.length > 0 && (
        <div className="mt-4 pt-3 border-t border-line">
          <h4 className="text-sm font-semibold mb-2 text-heading">
            {t('quotes.addOns.historyTitle', 'Changes')}
          </h4>
          <ol className="space-y-2 text-sm">
            {changes.map((change, index) => (
              <li key={`${change.at}-${index}`} className="text-body">
                <div className="text-heading">
                  <span className="font-medium">{fmtDateTime(change.at)}</span>
                  {' · '}
                  {change.by === 'customer'
                    ? t('quotes.addOns.byCustomer', 'by the customer')
                    : t('quotes.addOns.byYou', 'by you')}
                </div>
                {change.booked.length > 0 && (
                  <div>{t('quotes.addOns.booked', 'Booked: {{items}}', { items: change.booked.join(', ') })}</div>
                )}
                {change.removed.length > 0 && (
                  <div>{t('quotes.addOns.removed', 'Removed: {{items}}', { items: change.removed.join(', ') })}</div>
                )}
                <div className="tabular-nums text-soft">
                  {t('quotes.addOns.totalChange', 'Total {{before}} → {{after}}', {
                    before: formatMoneyMinor(Number(change.totalBeforeMinor), quote.currency),
                    after: formatMoneyMinor(Number(change.totalAfterMinor), quote.currency),
                  })}
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
    </Card>
  );
};
