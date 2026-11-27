import { format, parseISO } from 'date-fns';

/** The Analytics page's small bar chart: one bar per day, scaled to the largest. */
export function MiniChart({ data, color }: { data: Array<{ date: string; value: number }>; color: string }) {
  const max = Math.max(...data.map((d) => d.value));
  const height = 40;
  return (
    <div className="flex items-end gap-1 h-10">
      {data.map((item, index) => (
        <div
          key={index}
          className={`flex-1 ${color} rounded-t opacity-70 hover:opacity-100 transition-opacity`}
          style={{ height: `${max ? (item.value / max) * height : 0}px` }}
          title={`${format(parseISO(item.date), 'MMM d')}: ${item.value}`}
        />
      ))}
    </div>
  );
}
