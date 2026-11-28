import { api } from '../config/api';

export interface FontDefinition {
  family: string;
  weights: number[];
  // CSS generic to use as a fallback when building font-family strings.
  // Optional in the type so older backends without this field still work;
  // callers must default to 'sans-serif' when undefined.
  generic?: 'sans-serif' | 'serif' | 'cursive' | 'monospace';
  /** The file format per weight (issue 2618); woff2 when absent. */
  formats?: Record<number, 'woff2' | 'woff' | 'ttf'>;
  /** Each weight file's version, for its address (?v=): a replaced file gets a new one. */
  versions?: Record<number, string>;
  /** Shipped with PicPeak, or uploaded in the branding settings (removable). */
  source?: 'bundled' | 'uploaded';
}

export interface FontsListResponse {
  fonts: FontDefinition[];
}

/** The query key of the public font list (fontsService.list), shared by every font picker. */
export const FONTS_QUERY_KEY = ['fonts'] as const;

export const fontsService = {
  /**
   * List all self-hosted font families discovered by the backend scanner.
   * Cached aggressively at the React Query layer; the underlying endpoint
   * is also TTL-cached on the backend.
   */
  async list(): Promise<FontDefinition[]> {
    const res = await api.get<FontsListResponse>('/public/fonts');
    return res.data.fonts;
  },

  /** The same list for the branding settings, fresh (no public cache). */
  async listAdmin(): Promise<FontDefinition[]> {
    const res = await api.get<FontsListResponse>('/admin/settings/fonts');
    return res.data.fonts;
  },

  /** Upload one weight of a family (WOFF2, WOFF or TTF). */
  async upload(file: File, meta: { family: string; weight: number; generic: string }): Promise<{ family: string; weight: number; format: string }> {
    const form = new FormData();
    form.append('file', file);
    form.append('family', meta.family);
    form.append('weight', String(meta.weight));
    form.append('generic', meta.generic);
    const res = await api.post('/admin/settings/fonts', form, { headers: { 'Content-Type': 'multipart/form-data' } });
    return res.data;
  },

  async remove(family: string): Promise<void> {
    await api.delete(`/admin/settings/fonts/${encodeURIComponent(family)}`);
  },
};

/** A font weight's @font-face source: its file (versioned) and the format CSS names. */
export function fontFaceSource(family: string, weight: number, formats?: FontDefinition['formats'], versions?: FontDefinition['versions']): string {
  const file = formats?.[weight] || 'woff2';
  const cssFormat = file === 'ttf' ? 'truetype' : file;
  const version = versions?.[weight] && /^[a-z0-9]{1,40}$/.test(versions[weight]) ? `?v=${versions[weight]}` : '';
  return `url('/fonts/${encodeURIComponent(family.replace(/ /g, '-'))}/${weight}.${file}${version}') format('${cssFormat}')`;
}

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
