/**
 * The clause outline of the contract template editor (#1445): drag handles
 * (@dnd-kit — pointer and keyboard, with screen-reader announcements), the
 * up/down buttons, Alt+↑/↓ on a focused clause, and "page n" markers from the
 * last check's dry run between the clauses where the PDF breaks.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors,
  type Announcements, type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowDown, ArrowUp, GripVertical, Trash2 } from 'lucide-react';
import { Input } from '../../../components/common';
import { CONTRACT_SECTIONS, type ContractBlockSection } from '../../../services/contracts.service';
import type { ContractLocale, LocaleText, TemplatePublishCheck } from '../../../services/contractTemplates.service';
import { ClauseConditionField, LocaleTextField, fieldClass, iconButton, labelClass } from './TemplateEditorFields';

export interface DraftItem {
  key: string;
  kind: 'block' | 'text';
  blockId: number | null;
  section: ContractBlockSection;
  name: string;
  heading: string;
  /** A block's text in this template, or a free-text section's body. */
  body: LocaleText;
  /** The text a block override starts from (frozen or library). */
  baseText: LocaleText;
  blockArchived: boolean;
}

type FocusFor = (target: string) => { locale: ContractLocale; nonce: number } | null;

interface ClauseProps {
  item: DraftItem;
  index: number;
  count: number;
  expanded: boolean;
  readOnly: boolean;
  pages: { firstPage: number; lastPage: number } | null;
  onMove: (from: number, to: number) => void;
  onToggle: (key: string) => void;
  onRemove: (key: string) => void;
  onUpdate: (key: string, patch: Partial<DraftItem>, coalesce?: string) => void;
  focusFor: FocusFor;
}

const Clause: React.FC<ClauseProps> = ({
  item, index, count, expanded, readOnly, pages, onMove, onToggle, onRemove, onUpdate, focusFor,
}) => {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: item.key, disabled: readOnly,
  });
  const label = item.kind === 'block' ? item.name : (item.heading || t('contracts.templates.untitled', 'Untitled'));

  // Alt+↑/↓ anywhere on the clause but inside a text field, where the
  // browser's own caret movement wins.
  const onKeyDown = (e: React.KeyboardEvent<HTMLLIElement>) => {
    if (readOnly || !e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
    e.preventDefault();
    const to = index + (e.key === 'ArrowUp' ? -1 : 1);
    if (to >= 0 && to < count) onMove(index, to);
  };

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      onKeyDown={onKeyDown}
      data-clause-key={item.key}
      className={`rounded border border-neutral-200 dark:border-neutral-700 p-2 bg-white dark:bg-neutral-900 ${isDragging ? 'shadow-lg relative z-10' : ''}`}
    >
      <div className="flex items-center gap-2 flex-wrap">
        {!readOnly && (
          <button
            type="button"
            ref={setActivatorNodeRef}
            className={`${iconButton} cursor-grab touch-none`}
            aria-label={t('contracts.templates.dragHandle', 'Move “{{name}}” (drag, or Space then arrow keys)', { name: label }) as string}
            {...attributes}
            {...listeners}
          >
            <GripVertical className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        )}
        <span className="text-xs tabular-nums text-neutral-500 dark:text-neutral-400 w-6">{index + 1}.</span>
        <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-neutral-200 text-neutral-800 dark:bg-neutral-700 dark:text-neutral-200">
          {item.kind === 'block' ? t('contracts.templates.clause', 'Clause') : t('contracts.templates.freeText', 'Free text')}
        </span>
        <span className="text-xs text-neutral-500 dark:text-neutral-400">{t(`contracts.sections.${item.section}`, item.section)}</span>
        <span className="flex-1 min-w-[160px] text-sm font-medium text-neutral-900 dark:text-neutral-100">
          {label}
          {item.kind === 'block' && Object.keys(item.body).length > 0 && (
            <span className="ml-2 text-xs font-normal text-neutral-500 dark:text-neutral-400">{t('contracts.templates.customised', 'customised')}</span>
          )}
          {item.blockArchived && (
            <span className="ml-2 text-xs font-normal text-red-700 dark:text-red-400">{t('contracts.templates.archivedBlock', 'Archived in the library')}</span>
          )}
          {pages && pages.lastPage > pages.firstPage && (
            <span className="ml-2 text-xs font-normal text-neutral-500 dark:text-neutral-400">
              {t('contracts.templates.pageBreaks.spans', 'pages {{first}}–{{last}}', { first: pages.firstPage, last: pages.lastPage })}
            </span>
          )}
        </span>
        <div className="flex items-center gap-1">
          <button type="button" className={iconButton} disabled={readOnly || index === 0} onClick={() => onMove(index, index - 1)}
            aria-label={t('contracts.templates.moveUp', 'Move up') as string}><ArrowUp className="w-3.5 h-3.5" /></button>
          <button type="button" className={iconButton} disabled={readOnly || index === count - 1} onClick={() => onMove(index, index + 1)}
            aria-label={t('contracts.templates.moveDown', 'Move down') as string}><ArrowDown className="w-3.5 h-3.5" /></button>
          <button type="button" className="text-xs underline text-neutral-700 dark:text-neutral-300 px-1"
            aria-expanded={expanded} onClick={() => onToggle(item.key)}>
            {expanded ? t('contracts.templates.hideText', 'Hide text') : t('contracts.templates.showText', 'Text')}
          </button>
          {!readOnly && (
            <button type="button" className={iconButton} onClick={() => onRemove(item.key)}
              aria-label={t('contracts.templates.remove', 'Remove') as string}><Trash2 className="w-3.5 h-3.5" /></button>
          )}
        </div>
      </div>
      {expanded && (
        <div className="mt-2 space-y-2">
          {item.kind === 'text' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              <div>
                <label htmlFor={`${item.key}-section`} className={labelClass}>{t('contracts.templates.section', 'Section')}</label>
                <select id={`${item.key}-section`} className={fieldClass} value={item.section} disabled={readOnly}
                  onChange={(e) => onUpdate(item.key, { section: e.target.value as ContractBlockSection })}>
                  {CONTRACT_SECTIONS.map((s) => <option key={s} value={s}>{t(`contracts.sections.${s}`, s)}</option>)}
                </select>
              </div>
              <Input id={`${item.key}-heading`} label={t('contracts.templates.heading', 'Heading') as string}
                value={item.heading} maxLength={255} readOnly={readOnly}
                onChange={(e) => onUpdate(item.key, { heading: e.target.value }, `${item.key}:heading`)} />
            </div>
          )}
          <ClauseConditionField
            id={`${item.key}-condition`}
            body={item.body}
            baseText={item.baseText}
            readOnly={readOnly}
            onChange={(body) => onUpdate(item.key, { body })}
          />
          <LocaleTextField
            id={`${item.key}-body`}
            label={item.kind === 'block'
              ? t('contracts.templates.overrideLabel', 'Text in this template (leave empty to use the clause library\'s text)') as string
              : t('contracts.templates.body', 'Text') as string}
            value={item.body}
            hint={item.baseText}
            rows={5}
            readOnly={readOnly}
            onChange={(body, locale) => onUpdate(item.key, { body }, `${item.key}:body:${locale}`)}
            focusRequest={focusFor(item.key)}
          />
        </div>
      )}
    </li>
  );
};

/** A "page n" rule between two clauses. */
const PageMarker: React.FC<{ page: number; stale: boolean }> = ({ page, stale }) => {
  const { t } = useTranslation();
  return (
    <li aria-hidden={false} className={`flex items-center gap-2 text-xs ${stale ? 'text-neutral-400 dark:text-neutral-500' : 'text-neutral-600 dark:text-neutral-400'}`}>
      <span className="flex-1 border-t border-dashed border-current" />
      <span>
        {t('contracts.templates.pageBreaks.page', 'page {{page}}', { page })}
        {stale ? ` · ${t('contracts.templates.pageBreaks.stale', 'before your latest changes')}` : ''}
      </span>
      <span className="flex-1 border-t border-dashed border-current" />
    </li>
  );
};

export const TemplateClauseList: React.FC<{
  items: DraftItem[];
  expanded: Set<string>;
  readOnly: boolean;
  /** From the last check; markers are shown faded while the draft changed since. */
  itemPages: TemplatePublishCheck['itemPages'] | null;
  pagesStale: boolean;
  onMove: (from: number, to: number) => void;
  onToggle: (key: string) => void;
  onRemove: (key: string) => void;
  onUpdate: (key: string, patch: Partial<DraftItem>, coalesce?: string) => void;
  focusFor: FocusFor;
}> = ({ items, expanded, readOnly, itemPages, pagesStale, onMove, onToggle, onRemove, onUpdate, focusFor }) => {
  const { t } = useTranslation();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const nameOf = (id: string | number | undefined) => {
    const item = items.find((i) => i.key === id);
    return item ? (item.kind === 'block' ? item.name : item.heading) || t('contracts.templates.untitled', 'Untitled') : '';
  };
  const positionOf = (id: string | number | undefined) => items.findIndex((i) => i.key === id) + 1;
  const announcements: Announcements = {
    onDragStart: ({ active }) => t('contracts.templates.dnd.start', 'Picked up {{name}}, position {{position}} of {{count}}.',
      { name: nameOf(active.id), position: positionOf(active.id), count: items.length }) as string,
    onDragOver: ({ active, over }) => (over
      ? t('contracts.templates.dnd.over', '{{name}} is now at position {{position}} of {{count}}.',
        { name: nameOf(active.id), position: positionOf(over.id), count: items.length }) as string
      : undefined),
    onDragEnd: ({ active, over }) => (over
      ? t('contracts.templates.dnd.end', '{{name}} dropped at position {{position}} of {{count}}.',
        { name: nameOf(active.id), position: positionOf(over.id), count: items.length }) as string
      : undefined),
    onDragCancel: ({ active }) => t('contracts.templates.dnd.cancel', 'Moving {{name}} was cancelled.', { name: nameOf(active.id) }) as string,
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = items.findIndex((i) => i.key === active.id);
    const to = items.findIndex((i) => i.key === over.id);
    if (from >= 0 && to >= 0) onMove(from, to);
  };
  const pagesAt = (index: number) => (itemPages ? itemPages.find((p) => p.position === index + 1) || null : null);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
      accessibility={{
        announcements,
        screenReaderInstructions: {
          draggable: t('contracts.templates.dnd.instructions',
            'To move a clause, press Space or Enter, move it with the arrow keys, and press Space or Enter again to drop it. Press Escape to cancel.') as string,
        },
      }}
    >
      <SortableContext items={items.map((i) => i.key)} strategy={verticalListSortingStrategy}>
        <ol className="space-y-2">
          {items.map((item, index) => {
            const pages = pagesAt(index);
            const before = index > 0 ? pagesAt(index - 1) : null;
            // A marker where the dry run started a new page before this clause.
            const breakPage = pages && (index === 0 ? (pages.firstPage > 1 ? pages.firstPage : null)
              : (before && pages.firstPage > before.lastPage ? pages.firstPage : null));
            return (
              <React.Fragment key={item.key}>
                {breakPage ? <PageMarker page={breakPage} stale={pagesStale} /> : null}
                <Clause
                  item={item}
                  index={index}
                  count={items.length}
                  expanded={expanded.has(item.key)}
                  readOnly={readOnly}
                  pages={pages}
                  onMove={onMove}
                  onToggle={onToggle}
                  onRemove={onRemove}
                  onUpdate={onUpdate}
                  focusFor={focusFor}
                />
              </React.Fragment>
            );
          })}
        </ol>
      </SortableContext>
    </DndContext>
  );
};
