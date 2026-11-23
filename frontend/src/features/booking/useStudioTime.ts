import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { zonedWallClock } from '../../utils/zonedWallClock';

/** Dates and times of the studio's zone, in the viewer's formats. */
export function useStudioTime(timezone: string) {
  const { format, formatTime } = useLocalizedDate();
  // A wall-clock day (YYYY-MM-DD), read at noon so no zone moves it.
  const day = (wallDay: string) => format(new Date(`${wallDay}T12:00:00`));
  const dayOf = (instant: string) => day(zonedWallClock(instant, timezone).day);
  const time = (instant: string) => formatTime(zonedWallClock(instant, timezone).time);
  return { day, dayOf, time, at: (instant: string) => `${dayOf(instant)} ${time(instant)}` };
}
