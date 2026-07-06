/**
 * Settings → Branding card: lets the admin pick the font used on every
 * PDF (quotes, invoices, tax report) from the bundled families. Sits
 * directly beneath the web Typography customizer card on
 * `BrandingPage`, inside the left column — matches the typography
 * box width so the two visually pair.
 *
 * Controlled component. State + persistence live on the parent so the
 * page's top-level "Save changes" button writes this together with
 * the rest of the branding form (no card-local save button).
 *
 * Loads the same `/public/fonts` list the web font picker consumes,
 * so any family bundled in `backend/assets/fonts/` shows up here too
 * automatically. The selected value persists to
 * `business_profile.pdf_font_family` and pdfService maps it to
 * `<family>/400.ttf` (body) + `<family>/700.ttf` (bold) at render
 * time.
 *
 * Hidden by the caller when no PDF-producing feature is enabled
 * (quotes / bills / taxReport all off) — when there's no PDF surface
 * the setting is irrelevant.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Type } from 'lucide-react';
import { Card } from '../common';
import { fontsService } from '../../services/fonts.service';

/**
 * The bundled-fonts API returns the DISPLAY name (e.g. "Playfair
 * Display") but pdfService resolves a DIRECTORY name (e.g.
 * "Playfair-Display"). They're always related by space ↔ hyphen.
 * The helpers below convert between them so the dropdown can show
 * a clean human label while persisting the on-disk identifier.
 */
const familyToDirectory = (family: string) => family.replace(/ /g, '-');
const directoryToFamily = (dir: string) => dir.replace(/-/g, ' ');

export interface PdfTypographyCardProps {
  /** Directory name (e.g. "Inter", "Playfair-Display") or null/""
   *  for "Use Helvetica (default)". */
  value: string | null;
  onChange: (value: string | null) => void;
}

export const PdfTypographyCard: React.FC<PdfTypographyCardProps> = ({ value, onChange }) => {
  const { t } = useTranslation();

  // Same query the web typography picker consumes — single source of
  // truth for "which bundled families exist on disk".
  const { data: availableFonts } = useQuery({
    queryKey: ['fonts'],
    queryFn: () => fontsService.list(),
    staleTime: 60 * 60 * 1000, // fonts don't change at runtime
  });

  const selection = value || '';

  return (
    <Card className="p-6">
      <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-1 flex items-center gap-2">
        <Type className="w-5 h-5" />
        {t('branding.pdfTypography', 'PDF typography')}
      </h3>
      <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
        {t('branding.pdfTypographyHelp',
          'Used for invoice + quote letterheads. Pick one of the bundled fonts, or leave on default to use Helvetica.')}
      </p>

      <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
        {t('branding.pdfFontFamily', 'Body font')}
      </label>
      <select
        value={selection}
        onChange={(e) => onChange(e.target.value ? e.target.value : null)}
        className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100"
      >
        <option value="">
          {t('branding.pdfFontFamilyDefault', 'Use Helvetica (default)')}
        </option>
        {(availableFonts || []).map((f) => (
          <option key={f.family} value={familyToDirectory(f.family)}>
            {/* Show the display name (with spaces) — but persist
                the directory name (with hyphens) so pdfService can
                find the on-disk family without an extra lookup. */}
            {f.family}
          </option>
        ))}
        {/* When the saved value points at a family that's no
            longer on disk (e.g. uploaded by an earlier admin,
            later removed), still show it so the admin sees what
            they have rather than silently re-mapping to default. */}
        {selection && !(availableFonts || []).some((f) => familyToDirectory(f.family) === selection) && (
          <option value={selection}>
            {directoryToFamily(selection)} ({t('branding.pdfFontFamilyMissing', 'missing')})
          </option>
        )}
      </select>
    </Card>
  );
};
