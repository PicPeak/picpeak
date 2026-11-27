/**
 * A reorderable list for the website builder's pages and blocks: drag by the
 * handle (pointer, or Space then the arrow keys via @dnd-kit's keyboard
 * sensor), or the up/down buttons. Same pattern as the contract template
 * clause list.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent,
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
  selected?: boolean;
  readOnly?: boolean;
}

const iconButton = 'inline-flex items-center justify-center w-7 h-7 rounded-md text-faint hover:text-body hover:bg-hover disabled:opacity-30 disabled:hover:bg-transparent';

const Row: React.FC<RowProps> = ({ id, index, count, label, onMove, children, selected, readOnly }) => {
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
      className={`flex items-center gap-1 rounded-lg border bg-panel pl-1 pr-1.5 py-1 ${selected ? 'border-accent' : 'border-line'} ${isDragging ? 'shadow-lg relative z-10' : ''}`}
    >
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
    </li>
  );
};

interface SortableListProps<T> {
  items: T[];
  getId: (item: T) => string;
  getLabel: (item: T) => string;
  onMove: (from: number, to: number) => void;
  renderItem: (item: T, index: number) => React.ReactNode;
  selectedId?: string | null;
  /** Shown in order, without the handle and the move buttons. */
  readOnly?: boolean;
}

export function SortableList<T>({ items, getId, getLabel, onMove, renderItem, selectedId, readOnly = false }: SortableListProps<T>) {
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
            <Row key={getId(item)} id={getId(item)} index={index} count={items.length} label={getLabel(item)} onMove={onMove} selected={selectedId === getId(item)} readOnly={readOnly}>
              {renderItem(item, index)}
            </Row>
          ))}
        </ol>
      </SortableContext>
    </DndContext>
  );
}
