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
export type PdfLogoPosition = 'right' | 'left' | 'center';
export type PdfLogoStack = 'above' | 'inline';
/** Millimetres; the top margin is not a setting (the address window sets it). */
export interface PdfMargins { left?: number; right?: number; bottom?: number }

/** What a scope stores; every key is optional (missing = inherited). */
export interface PdfThemeSettings {
  colors?: Partial<Record<PdfColorKey, string>>;
  titleSize?: number;
  footer?: { mode: PdfFooterMode; text?: string };
  pageNumbers?: PdfPageNumbers;
  foldingMarks?: PdfFoldingMarks;
  fontFamily?: string;
  layout?: { margins?: PdfMargins; addressWindow?: boolean };
  logo?: { position?: PdfLogoPosition; stack?: PdfLogoStack };
  /** 9–12 pt. */
  bodySize?: number;
  /** 1.2–1.6. */
  lineHeight?: number;
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
  layout: { margins: PdfMargins | null; addressWindow: boolean };
  logo: { position: PdfLogoPosition; stack: PdfLogoStack };
  bodySize: number;
  lineHeight: number | null;
}

/** A readability warning — shown, never enforced. */
export interface PdfThemeWarning {
  code: 'CONTRAST_LOW' | 'BODY_SIZE_SMALL' | 'LINE_HEIGHT_TIGHT' | 'LINE_TOO_LONG';
  key?: PdfColorKey;
  value: number;
  limit: number;
}

export interface PdfThemeRow {
  scope: PdfThemeScope;
  settings: PdfThemeSettings;
  updatedAt: string | null;
  resolved: ResolvedPdfTheme;
  warnings?: PdfThemeWarning[];
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
