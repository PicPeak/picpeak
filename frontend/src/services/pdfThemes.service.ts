/**
 * PDF themes (#1445): the look of quote, invoice and contract PDFs.
 * `default` applies to every document type; the others override it.
 */
import { api } from '../config/api';

export type PdfThemeScope = 'default' | 'quote' | 'invoice' | 'contract';
export type PdfColorKey = 'text' | 'muted' | 'subtle' | 'accent' | 'rule';
export type PdfFooterMode = 'address' | 'custom' | 'none';
export type PdfPageNumbers = 'bottom-right' | 'bottom-center' | 'none';
export type PdfFoldingMarks = 'none' | 'half' | 'third' | 'both';

/** What a scope stores; every key is optional (missing = inherited). */
export interface PdfThemeSettings {
  colors?: Partial<Record<PdfColorKey, string>>;
  titleSize?: number;
  footer?: { mode: PdfFooterMode; text?: string };
  pageNumbers?: PdfPageNumbers;
  foldingMarks?: PdfFoldingMarks;
  fontFamily?: string;
}

/** The theme a scope actually renders with. */
export interface ResolvedPdfTheme {
  scope: PdfThemeScope;
  fontFamily: string | null;
  colors: Record<PdfColorKey, string>;
  titleSize: number;
  footer: { mode: PdfFooterMode; text: string };
  pageNumbers: PdfPageNumbers;
  foldingMarks: PdfFoldingMarks;
}

export interface PdfThemeRow {
  scope: PdfThemeScope;
  settings: PdfThemeSettings;
  updatedAt: string | null;
  resolved: ResolvedPdfTheme;
}

export interface PdfThemeList {
  themes: PdfThemeRow[];
  /** Bundled font directory names, e.g. "Jost", "Playfair-Display". */
  fontFamilies: string[];
}

export const pdfThemesService = {
  async list(): Promise<PdfThemeList> {
    const { data } = await api.get('/admin/pdf-themes');
    return data.data || data;
  },
  /** Replace a scope's settings; `{}` clears it back to inherited. */
  async save(scope: PdfThemeScope, settings: PdfThemeSettings): Promise<PdfThemeList> {
    const { data } = await api.put(`/admin/pdf-themes/${scope}`, { settings });
    return data.data || data;
  },
  /** A sample PDF rendered with these (unsaved) settings, as an object URL. */
  async previewUrl(scope: PdfThemeScope, settings: PdfThemeSettings): Promise<string> {
    const res = await api.post(`/admin/pdf-themes/${scope}/preview`, { settings }, { responseType: 'blob' });
    return URL.createObjectURL(res.data);
  },
};
