import React from 'react';
import { cn } from '../../lib/utils';

type Props<T> = React.HTMLAttributes<T> & { className?: string };

/**
 * List tables. `Table` is the card around it and the only thing that may
 * scroll sideways; the page never does (STYLING.md › Layout). Sortable
 * columns put `SortableHeader` inside a `TableHeaderCell`. A `className`
 * wins over the defaults (`text-heading` on a cell replaces `text-body`).
 */
export const Table: React.FC<Props<HTMLTableElement> & { containerClassName?: string }> = ({
  className,
  containerClassName,
  children,
  ...props
}) => (
  <div className={cn('bg-panel border border-line rounded-xl overflow-x-auto', containerClassName)}>
    <table className={cn('w-full text-sm', className)} {...props}>{children}</table>
  </div>
);

export const TableHead: React.FC<Props<HTMLTableSectionElement>> = ({ className, ...props }) => (
  <thead className={cn('bg-subtle border-b border-line', className)} {...props} />
);

export const TableBody: React.FC<Props<HTMLTableSectionElement>> = ({ className, ...props }) => (
  <tbody className={cn('divide-y divide-line-faint', className)} {...props} />
);

export const TableRow: React.FC<Props<HTMLTableRowElement> & { interactive?: boolean }> = ({
  className,
  interactive = false,
  ...props
}) => (
  <tr className={cn(interactive && 'hover:bg-hover-soft cursor-pointer', className)} {...props} />
);

export const TableHeaderCell: React.FC<React.ThHTMLAttributes<HTMLTableCellElement> & { align?: 'left' | 'right' | 'center' }> = ({
  className,
  align = 'left',
  ...props
}) => (
  <th
    scope="col"
    className={cn(
      'px-4 py-3 text-xs font-medium uppercase tracking-wide text-muted whitespace-nowrap',
      align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left',
      className,
    )}
    {...props}
  />
);

export const TableCell: React.FC<React.TdHTMLAttributes<HTMLTableCellElement> & { align?: 'left' | 'right' | 'center' }> = ({
  className,
  align = 'left',
  ...props
}) => (
  <td
    className={cn(
      'px-4 py-3 text-body',
      align === 'right' ? 'text-right tabular-nums' : align === 'center' ? 'text-center' : 'text-left',
      className,
    )}
    {...props}
  />
);
