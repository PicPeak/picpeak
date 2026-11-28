/**
 * A reorderable list for the website builder's pages and blocks: drag by the
 * handle (pointer, or Space then the arrow keys via @dnd-kit's keyboard
 * sensor), or the up/down buttons. Same pattern as the contract template
 * clause list.
 */
import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent, type Modifier,
} from '@dnd-kit/core';
import {
  SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowDown, ArrowUp, GripVertical } from 'lucide-react';

interface RowProps {
  id: string;
  index: number;
  count: number;
  label: string;
  onMove: (from: number, to: number) => void;
  children: React.ReactNode;
  /** The row's own form, shown under it while it is edited. */
  details?: React.ReactNode;
  selected?: boolean;
  readOnly?: boolean;
}

/**
 * A row's form, opened right under the row: brought into view, its first
 * field focused, so it is found also in a list longer than the panel.
 */
const RowDetails: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    box.scrollIntoView?.({ block: 'nearest' });
    box.querySelector<HTMLElement>('input, select, textarea, [contenteditable="true"]')?.focus({ preventScroll: true });
  }, []);
  return <div ref={ref} className="border-t border-line p-3 space-y-3">{children}</div>;
};

const iconButton = 'inline-flex items-center justify-center w-7 h-7 rounded-md text-faint hover:text-body hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-30 disabled:hover:bg-transparent';

const Row: React.FC<RowProps> = ({ id, index, count, label, onMove, children, details, selected, readOnly }) => {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: readOnly });
  if (readOnly) {
    return (
      <li className={`rounded-lg border bg-panel px-1.5 py-1 ${selected ? 'border-accent' : 'border-line'}`}>{children}</li>
    );
  }
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`rounded-lg border bg-panel ${selected ? 'border-accent' : 'border-line'} ${isDragging ? 'shadow-lg relative z-10' : ''}`}
    >
      <div className="flex items-center gap-1 pl-1 pr-1.5 py-1">
      <button
        type="button"
        ref={setActivatorNodeRef}
        className={`${iconButton} cursor-grab touch-none`}
        aria-label={t('website.list.drag', 'Move “{{name}}” (drag, or Space then arrow keys)', { name: label }) as string}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="w-4 h-4" aria-hidden="true" />
      </button>
      <div className="flex-1 min-w-0">{children}</div>
      <button type="button" className={iconButton} disabled={index === 0} onClick={() => onMove(index, index - 1)}
        aria-label={t('website.list.moveUp', 'Move “{{name}}” up', { name: label }) as string}>
        <ArrowUp className="w-4 h-4" aria-hidden="true" />
      </button>
      <button type="button" className={iconButton} disabled={index === count - 1} onClick={() => onMove(index, index + 1)}
        aria-label={t('website.list.moveDown', 'Move “{{name}}” down', { name: label }) as string}>
        <ArrowDown className="w-4 h-4" aria-hidden="true" />
      </button>
      </div>
      {details && <RowDetails>{details}</RowDetails>}
    </li>
  );
};

/**
 * Dragging moves an item up and down within its list only: no sideways
 * drift, and not past the list's ends (what @dnd-kit/modifiers'
 * restrictToVerticalAxis and restrictToParentElement do together).
 */
export const verticalWithinList: Modifier = ({ transform, draggingNodeRect, containerNodeRect }) => {
  const next = { ...transform, x: 0 };
  if (!draggingNodeRect || !containerNodeRect) return next;
  const minY = containerNodeRect.top - draggingNodeRect.top;
  const maxY = containerNodeRect.bottom - draggingNodeRect.bottom;
  next.y = Math.min(Math.max(transform.y, minY), maxY);
  return next;
};

interface SortableListProps<T> {
  items: T[];
  getId: (item: T) => string;
  getLabel: (item: T) => string;
  onMove: (from: number, to: number) => void;
  renderItem: (item: T, index: number) => React.ReactNode;
  selectedId?: string | null;
  /** The form of an item being edited, shown under its row (null: none). */
  renderDetails?: (item: T, index: number) => React.ReactNode;
  /** Shown in order, without the handle and the move buttons. */
  readOnly?: boolean;
}

export function SortableList<T>({ items, getId, getLabel, onMove, renderItem, selectedId, renderDetails, readOnly = false }: SortableListProps<T>) {
  const { t } = useTranslation();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = items.map(getId);
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (readOnly || !over || active.id === over.id) return;
    onMove(ids.indexOf(String(active.id)), ids.indexOf(String(over.id)));
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[verticalWithinList]}
      onDragEnd={onDragEnd}
      accessibility={{
        screenReaderInstructions: {
          draggable: t('website.list.dragInstructions',
            'To move an item, press Space or Enter, move it with the arrow keys, and press Space or Enter again to drop it. Press Escape to cancel.') as string,
        },
      }}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ol className="space-y-1.5">
          {items.map((item, index) => (
            <Row key={getId(item)} id={getId(item)} index={index} count={items.length} label={getLabel(item)} onMove={onMove} selected={selectedId === getId(item)} readOnly={readOnly}
              details={readOnly ? null : renderDetails?.(item, index)}>
              {renderItem(item, index)}
            </Row>
          ))}
        </ol>
      </SortableContext>
    </DndContext>
  );
}
