import { useQuery } from '@tanstack/react-query';
import { useFeatureFlags } from '../../contexts/FeatureFlagsContext';
import { usePermissions } from '../../contexts/PermissionsContext';
import { bookingService } from '../../services/booking.service';

/**
 * Whether CRM → Bookings can be opened. With `calendarBooking` on, always.
 * Switched off, the page stays reachable while deposits still wait for a
 * decision (the backend keeps reading and deciding open for those), so a
 * studio that turns booking off can still refund, decline or book them.
 */
export function useBookingsReachable(): { reachable: boolean; flagOn: boolean; isLoading: boolean } {
  const { flags, isLoading: flagsLoading } = useFeatureFlags();
  const { hasPermission } = usePermissions();
  const flagOn = Boolean(flags.calendarBooking);
  const ask = !flagsLoading && !flagOn && Boolean(flags.quotes) && hasPermission('quotes.view');
  const { data: open = false, isLoading } = useQuery({
    queryKey: ['booking-decisions-open'],
    queryFn: () => bookingService.decisionsOpen().catch(() => false),
    enabled: ask,
    staleTime: 60_000,
  });
  return { reachable: flagOn || open, flagOn, isLoading: flagsLoading || (ask && isLoading) };
}
