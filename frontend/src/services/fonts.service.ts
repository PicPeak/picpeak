import { api } from '../config/api';

export interface FontDefinition {
  family: string;
  weights: number[];
  // CSS generic to use as a fallback when building font-family strings.
  // Optional in the type so older backends without this field still work;
  // callers must default to 'sans-serif' when undefined.
  generic?: 'sans-serif' | 'serif' | 'cursive' | 'monospace';
}

export interface FontsListResponse {
  fonts: FontDefinition[];
}

export const fontsService = {
  /**
   * List all self-hosted font families discovered by the backend scanner.
   * Cached aggressively at the React Query layer; the underlying endpoint
   * is also TTL-cached on the backend.
   */
  async list(): Promise<FontDefinition[]> {
    const res = await api.get<FontsListResponse>('/public/fonts');
    return res.data.fonts;
  }
};

const GENERIC_FAMILIES = new Set([
  'sans-serif',
  'serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-sans-serif',
  'ui-serif',
  'ui-monospace',
  'ui-rounded'
]);

/**
 * Extract the primary font family name from a CSS font-family string.
 *
 * "'Jost', sans-serif"            → "Jost"
 * "Inter, sans-serif"             → "Inter"
 * "'Playfair Display', serif"     → "Playfair Display"
 * "system-ui, sans-serif"         → null   (generic, no @font-face needed)
 * undefined / "" / "sans-serif"   → null
 */
export function extractFamilyName(cssFontFamily: string | undefined | null): string | null {
  if (!cssFontFamily) return null;
  const first = cssFontFamily.split(',')[0]?.trim();
  if (!first) return null;
  // Strip surrounding single or double quotes
  const unquoted = first.replace(/^['"]|['"]$/g, '').trim();
  if (!unquoted) return null;
  if (GENERIC_FAMILIES.has(unquoted.toLowerCase())) return null;
  return unquoted;
}
