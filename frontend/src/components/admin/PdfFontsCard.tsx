/**
 * Settings → Branding: uploaded PDF fonts (#1445). An admin adds a family —
 * the regular face, optionally bold and italic — as TTF or OTF files, names
 * it, notes its licence and confirms the right to embed it in documents.
 * The server checks each file by its content (format, completeness, size,
 * the font's own embedding permission) before storing anything. Fonts are
 * archived, never deleted; a theme using an archived font falls back to
 * Helvetica.
 */
import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Type } from 'lucide-react';
import { toast } from 'react-toastify';
import { Button, Card } from '../common';
import { PermissionGate } from './PermissionGate';
import { pdfThemesService } from '../../services/pdfThemes.service';

const fieldClass = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-neutral-900 w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 '
  + 'bg-white dark:bg-neutral-800 text-sm text-neutral-900 dark:text-neutral-100';
const labelClass = 'block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1';
const FACES = ['regular', 'bold', 'italic'] as const;
type Face = (typeof FACES)[number];
const STYLE_FACE: Record<string, Face> = { 400: 'regular', 700: 'bold', '400i': 'italic' };
const FACE_LABELS: Record<Face, string> = { regular: 'Regular', bold: 'Bold', italic: 'Italic' };

function apiError(err: unknown): { message?: string; code?: string } {
  const data = (err as { response?: { data?: { error?: string; code?: string } } })?.response?.data;
  return { message: data?.error, code: data?.code };
}

export const PdfFontsCard: React.FC = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['pdf-fonts'], queryFn: () => pdfThemesService.fonts() });
  const [name, setName] = useState('');
  const [licenceNote, setLicenceNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [files, setFiles] = useState<Partial<Record<Face, File>>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);

  const ready = name.trim() && licenceNote.trim() && confirmed && files.regular;

  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['pdf-fonts'] }),
    queryClient.invalidateQueries({ queryKey: ['pdf-themes'] }),
  ]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || !files.regular) return;
    setBusy(true);
    setProblem(null);
    try {
      await pdfThemesService.uploadFont({
        name: name.trim(), licenceNote: licenceNote.trim(), regular: files.regular, bold: files.bold, italic: files.italic,
      });
      toast.success(t('branding.pdfFonts.uploaded', 'Font added'));
      setName('');
      setLicenceNote('');
      setConfirmed(false);
      setFiles({});
      form.current?.reset();
      await refresh();
    } catch (err) {
      const { message, code } = apiError(err);
      setProblem(code ? t(`branding.pdfFonts.errors.${code}`, message || code) as string
        : t('branding.pdfFonts.uploadFailed', 'The font could not be added.') as string);
    } finally {
      setBusy(false);
    }
  };

  const archive = async (id: number) => {
    if (!window.confirm(t('branding.pdfFonts.archiveConfirm', 'Archive this font? Documents whose theme uses it fall back to Helvetica.') as string)) return;
    try {
      await pdfThemesService.archiveFont(id);
      await refresh();
    } catch (err) {
      toast.error(apiError(err).message || t('branding.pdfFonts.archiveFailed', 'The font could not be archived.'));
    }
  };

  const fonts = data?.fonts || [];

  return (
    <Card padding="md" className="mb-6">
      <div className="flex items-start gap-3 mb-4">
        <Type className="w-5 h-5 mt-0.5 text-neutral-600 dark:text-neutral-300" aria-hidden />
        <div>
          <h3 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">{t('branding.pdfFonts.title', 'Your fonts for PDFs')}</h3>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {t('branding.pdfFonts.description', 'Add your brand font as TTF or OTF files (up to 5 MB each). Once added, pick it in the PDF theme.')}
          </p>
        </div>
      </div>

      {fonts.length > 0 && (
        <ul className="divide-y divide-neutral-200 dark:divide-neutral-700 mb-4">
          {fonts.map((font) => (
            <li key={font.id} className="py-2 flex flex-wrap items-center gap-3 text-sm">
              <span className="font-medium text-neutral-900 dark:text-neutral-100">{font.name}</span>
              <span className="text-xs text-neutral-600 dark:text-neutral-400">
                {font.files.map((f) => t(`branding.pdfFonts.face.${STYLE_FACE[f.style]}`, FACE_LABELS[STYLE_FACE[f.style]] || f.style)).join(' · ')}
              </span>
              {!font.isActive && <span className="text-xs text-neutral-500">{t('branding.pdfFonts.archived', 'Archived')}</span>}
              <span className="flex-1 text-xs text-neutral-600 dark:text-neutral-400 truncate" title={font.licenceNote}>{font.licenceNote}</span>
              {font.isActive && (
                <PermissionGate permission="settings.banking">
                  <Button variant="outline" size="sm" onClick={() => archive(font.id)}>{t('branding.pdfFonts.archive', 'Archive')}</Button>
                </PermissionGate>
              )}
            </li>
          ))}
        </ul>
      )}

      <PermissionGate permission="settings.banking">
        <form ref={form} onSubmit={submit} className="space-y-3" aria-labelledby="pdf-fonts-add">
          <h4 id="pdf-fonts-add" className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{t('branding.pdfFonts.add', 'Add a font')}</h4>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {FACES.map((face) => (
              <div key={face}>
                <label htmlFor={`pdf-font-${face}`} className={labelClass}>
                  {t(`branding.pdfFonts.face.${face}`, FACE_LABELS[face])}{face === 'regular' ? ' *' : ''}
                </label>
                <input id={`pdf-font-${face}`} type="file" accept=".ttf,.otf,font/ttf,font/otf" className="text-sm"
                  onChange={(e) => setFiles((cur) => ({ ...cur, [face]: e.target.files?.[0] }))} />
              </div>
            ))}
          </div>
          <div>
            <label htmlFor="pdf-font-name" className={labelClass}>{t('branding.pdfFonts.name', 'Name')} *</label>
            <input id="pdf-font-name" className={fieldClass} maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label htmlFor="pdf-font-licence" className={labelClass}>{t('branding.pdfFonts.licenceNote', 'Licence')} *</label>
            <textarea id="pdf-font-licence" rows={2} maxLength={500} className={fieldClass} value={licenceNote}
              placeholder={t('branding.pdfFonts.licencePlaceholder', 'e.g. SIL Open Font License 1.1, or: desktop licence bought with the brand kit, allows embedding') as string}
              onChange={(e) => setLicenceNote(e.target.value)} />
          </div>
          <label className="flex items-start gap-2 text-sm text-neutral-800 dark:text-neutral-200">
            <input type="checkbox" className="mt-1" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            {t('branding.pdfFonts.confirm', 'I have the right to embed this font in the documents I send.')}
          </label>
          {problem && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{problem}</p>}
          <div className="flex justify-end">
            <Button type="submit" disabled={!ready || busy}>{t('branding.pdfFonts.upload', 'Add font')}</Button>
          </div>
        </form>
      </PermissionGate>
    </Card>
  );
};
