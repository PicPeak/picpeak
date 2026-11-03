/**
 * Postal addresses in the convention of their country — the admin-side
 * mirror of backend/src/utils/postalAddress.js, for previews that must read
 * like what the backend renders. A US address's city line is
 * "Denver, CO 80202"; everywhere else keeps "LI-9494 Schaan".
 */

export function isUnitedStates(countryCode?: string | null): boolean {
  return String(countryCode || '').trim().toUpperCase() === 'US';
}

interface CityLineParts {
  postalCode?: string | null;
  city?: string | null;
  state?: string | null;
  countryCode?: string | null;
}

/** The line under the street: "Denver, CO 80202" in the US, "LI-9494 Schaan" elsewhere. */
export function cityLine({ postalCode, city, state, countryCode }: CityLineParts): string {
  const pc = (postalCode || '').trim();
  const town = (city || '').trim();
  if (isUnitedStates(countryCode)) {
    const region = (state || '').trim();
    const stateZip = [region, pc].filter(Boolean).join(' ');
    return [town, stateZip].filter(Boolean).join(region ? ', ' : ' ');
  }
  const cc = (countryCode || '').trim().toUpperCase();
  return [cc && pc ? `${cc}-${pc}` : (pc || cc), town].filter(Boolean).join(' ');
}
