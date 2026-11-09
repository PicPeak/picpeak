import { useQuery } from '@tanstack/react-query';
import { businessProfileService } from '../services/businessProfile.service';
import { isUnitedKingdom } from '../utils/postalAddress';

/**
 * Is the business in the United Kingdom? Its invoices and quotes round the
 * VAT total down, an invoice in another currency states its VAT in GBP, and
 * its customers are a business or a consumer (issue 2439).
 *
 * Read from GET /business-profile/region, which anyone who writes invoices,
 * quotes or customers may call, so an admin without settings access still
 * sees the GBP rate field the send asks for. Under the `business-profile`
 * key, so saving the profile refreshes it.
 */
export function useUkBusiness(): boolean {
  const { data } = useQuery({
    queryKey: ['business-profile', 'region'],
    queryFn: () => businessProfileService.getRegion(),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  return isUnitedKingdom(data?.countryCode);
}
