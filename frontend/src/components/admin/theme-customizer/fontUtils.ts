import { extractFamilyName, type FontDefinition } from '../../../services/fonts.service';

/**
 * Build the CSS font-family value for a scanned font, using the generic
 * fallback the backend supplied (from each family's optional meta.json).
 * Defaults to 'sans-serif' when the backend doesn't report one — keeps
 * compatibility with backends that predate the generic field.
 */
export function buildFontFamilyValue(font: FontDefinition): string {
  const generic = font.generic ?? 'sans-serif';
  // Always quote the family name (covers multi-word like 'Playfair Display').
  return `'${font.family}', ${generic}`;
}

/**
 * Match a saved CSS font-family string against the available scanned families
 * and return the canonical option value the dropdown renders. Handles both
 * legacy unquoted strings ("Inter, sans-serif") and the new quoted format
 * ("'Inter', sans-serif"), so events saved before this change still show the
 * right option as selected.
 */
export function resolveFontDropdownValue(
  saved: string | undefined,
  available: FontDefinition[] | undefined,
  fallback: string
): string {
  if (!saved) return fallback;
  const family = extractFamilyName(saved);
  if (!family) return saved; // generic family like "system-ui, sans-serif"
  const match = (available || []).find(
    (f) => f.family.toLowerCase() === family.toLowerCase()
  );
  return match ? buildFontFamilyValue(match) : saved;
}
