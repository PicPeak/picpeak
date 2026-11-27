/**
 * Fonts (Settings › Branding, issue 2618): the families the galleries and the
 * website offer, an upload for new ones (one weight at a time; WOFF2, WOFF or
 * TTF, up to 2 MB) and removing an uploaded family. Shipped fonts stay.
 */
import React, { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { Trash2, Type, Upload } from 'lucide-react';
import { Button, Card } from '../common';
import { useConfirm } from '../common/ConfirmDialog';
import { fontsService } from '../../services/fonts.service';
import { apiErrorText } from '../../utils/apiErrorText';

const WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900];
const GENERICS = ['sans-serif', 'serif', 'cursive', 'monospace'] as const;

export const FontsCard: React.FC = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const ids = { name: useId(), weight: useId(), generic: useId(), file: useId() };
  const [family, setFamily] = useState('');
  const [weight, setWeight] = useState(400);
  const [generic, setGeneric] = useState<string>('sans-serif');
  const [file, setFile] = useState<File | null>(null);
  const { data: fonts = [] } = useQuery({ queryKey: ['admin-fonts'], queryFn: fontsService.listAdmin });
  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['admin-fonts'] }),
    queryClient.invalidateQueries({ queryKey: ['public-fonts'] }),
  ]);
  const upload = useMutation({
    mutationFn: () => fontsService.upload(file as File, { family: family.trim(), weight, generic }),
    onSuccess: () => { toast.success(t('branding.fonts.uploaded', 'Font uploaded')); setFile(null); void refresh(); },
    onError: (err) => toast.error(apiErrorText(err)),
  });
  const remove = useMutation({
    mutationFn: (name: string) => fontsService.remove(name),
    onSuccess: () => { void refresh(); },
    onError: (err) => toast.error(apiErrorText(err)),
  });
  const askRemove = async (name: string) => {
    const ok = await confirm({
      title: t('branding.fonts.removeTitle', 'Remove this font?'),
      message: t('branding.fonts.removeMessage', 'Galleries and website pages that use it fall back to their default font.'),
      confirmLabel: t('common.remove', 'Remove'),
      variant: 'danger',
    });
    if (ok) remove.mutate(name);
  };

  return (
    <Card padding="md" id="fonts">
      <div className="flex items-center gap-2 mb-1">
        <Type className="w-5 h-5 text-soft" aria-hidden="true" />
        <h2 className="text-lg font-semibold text-heading">{t('branding.fonts.title', 'Fonts')}</h2>
      </div>
      <p className="text-sm text-soft mb-4">
        {t('branding.fonts.intro', 'The fonts your galleries and website can use. Upload a font you have the right to use on the web, one weight at a time.')}
      </p>
      <ul className="divide-y divide-line mb-5">
        {fonts.map((font) => (
          <li key={font.family} className="flex items-center gap-3 py-2">
            <span className="flex-1 min-w-0">
              <span className="block text-sm font-medium text-heading">{font.family}</span>
              <span className="block text-xs text-muted">
                {font.weights.join(' · ')} · {font.source === 'uploaded' ? t('branding.fonts.uploadedLabel', 'Uploaded') : t('branding.fonts.bundledLabel', 'Included')}
              </span>
            </span>
            {font.source === 'uploaded' && (
              <Button size="sm" variant="ghost" leftIcon={<Trash2 className="w-4 h-4" />} isLoading={remove.isPending && remove.variables === font.family}
                onClick={() => { void askRemove(font.family); }}
                aria-label={t('branding.fonts.remove', 'Remove {{name}}', { name: font.family }) as string}>
                {t('common.remove', 'Remove')}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={ids.name} className="block text-sm font-medium text-body mb-1">{t('branding.fonts.name', 'Font name')}</label>
          <input id={ids.name} className="input" value={family} maxLength={60} placeholder="Studio Serif" onChange={(e) => setFamily(e.target.value)} />
        </div>
        <div>
          <label htmlFor={ids.weight} className="block text-sm font-medium text-body mb-1">{t('branding.fonts.weight', 'Weight')}</label>
          <select id={ids.weight} className="input" value={weight} onChange={(e) => setWeight(Number(e.target.value))}>
            {WEIGHTS.map((w) => <option key={w} value={w}>{w}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={ids.generic} className="block text-sm font-medium text-body mb-1">{t('branding.fonts.style', 'Style')}</label>
          <select id={ids.generic} className="input" value={generic} onChange={(e) => setGeneric(e.target.value)}>
            {GENERICS.map((g) => <option key={g} value={g}>{t(`branding.fonts.generic.${g}`, g)}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={ids.file} className="block text-sm font-medium text-body mb-1">{t('branding.fonts.file', 'Font file')}</label>
          <input id={ids.file} type="file" accept=".woff2,.woff,.ttf,font/woff2,font/woff,font/ttf" className="block w-full text-sm"
            onChange={(e) => setFile(e.target.files?.[0] || null)} />
        </div>
      </div>
      <p className="mt-2 text-xs text-muted">{t('branding.fonts.fileHint', 'WOFF2 (best), WOFF or TTF, up to 2 MB.')}</p>
      <div className="mt-3">
        <Button variant="secondary" leftIcon={<Upload className="w-4 h-4" />} isLoading={upload.isPending}
          disabled={!file || !family.trim()} onClick={() => upload.mutate()}>
          {t('branding.fonts.upload', 'Upload font')}
        </Button>
      </div>
    </Card>
  );
};
