/**
 * Site-wide look of the website (issue 2618). Everything starts from the
 * gallery branding (logo, palette, fonts, button style); a value set here
 * overrides it for the website only.
 */
import React, { useId } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, RotateCcw } from 'lucide-react';
import { Button } from '../../components/common';
import { fontsService } from '../../services/fonts.service';
import { settingsTabHref } from '../settings/settingsNav';
import { ChoiceField, SelectField, TextArea, labelClass } from './fields';
import type { WebsiteDocument, WebsiteTheme } from './types';

interface SitePanelProps {
  doc: WebsiteDocument;
  update: (fn: (doc: WebsiteDocument) => WebsiteDocument, field?: string) => void;
  readOnly: boolean;
}

const HEX = /^#[0-9a-f]{6}$/i;

const ColorField: React.FC<{ label: string; value: string | null; onChange: (value: string | null) => void }> = ({ label, value, onChange }) => {
  const { t } = useTranslation();
  const id = useId();
  return (
    <div className="flex items-center gap-3">
      <input id={id} type="color" className="h-9 w-12 rounded-md border border-line-strong bg-panel p-1"
        value={value && HEX.test(value) ? value : '#000000'} onChange={(e) => onChange(e.target.value)} />
      <label htmlFor={id} className="flex-1 min-w-0">
        <span className="block text-sm font-medium text-body">{label}</span>
        <span className="block text-xs text-muted">{value || t('website.site.fromBranding', 'From branding')}</span>
      </label>
      {value && (
        <Button size="icon-sm" variant="ghost" onClick={() => onChange(null)} aria-label={t('website.site.resetColor', 'Use the branding colour for {{name}}', { name: label }) as string}>
          <RotateCcw className="w-4 h-4" />
        </Button>
      )}
    </div>
  );
};

export const SitePanel: React.FC<SitePanelProps> = ({ doc, update, readOnly }) => {
  const { t } = useTranslation();
  const fonts = useQuery({ queryKey: ['public-fonts'], queryFn: fontsService.list, staleTime: 5 * 60 * 1000 });
  const setTheme = (patch: Partial<WebsiteTheme>, field?: string) => update((d) => ({ ...d, theme: { ...d.theme, ...patch } }), field);
  const fontOptions = [
    { value: '', label: t('website.site.fromBranding', 'From branding') },
    ...(fonts.data || []).map((f) => ({ value: f.family, label: f.family })),
  ];

  return (
    <fieldset disabled={readOnly} className="space-y-6">
      <legend className="sr-only">{t('website.site.title', 'Site design')}</legend>
      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-heading">{t('website.site.title', 'Site design')}</h3>
        <p className="text-xs text-muted">
          {t('website.site.intro', 'Logo, colours and fonts come from your branding, so the website and the galleries match. Change them here only for the website.')}
        </p>
        <Link to={settingsTabHref('branding')} className="inline-flex items-center gap-1 text-sm text-accent hover:underline">
          {t('website.site.openBranding', 'Open branding settings')}
          <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
        </Link>
      </section>

      <section className="space-y-4">
        <SelectField label={t('website.site.headingFont', 'Heading font')} value={doc.theme.headingFont || ''} options={fontOptions}
          onChange={(v) => setTheme({ headingFont: v || null })} />
        <SelectField label={t('website.site.bodyFont', 'Text font')} value={doc.theme.bodyFont || ''} options={fontOptions}
          onChange={(v) => setTheme({ bodyFont: v || null })} />
        <ChoiceField
          label={t('website.site.buttonStyle', 'Buttons')}
          value={doc.theme.buttonStyle || ''}
          options={[
            { value: '', label: t('website.site.fromBranding', 'From branding') },
            { value: 'solid', label: t('website.site.solid', 'Filled') },
            { value: 'outline', label: t('website.site.outline', 'Outline') },
            { value: 'pill', label: t('website.site.pill', 'Rounded') },
          ]}
          onChange={(v) => setTheme({ buttonStyle: (v || null) as WebsiteTheme['buttonStyle'] })}
        />
      </section>

      <section className="space-y-3">
        <span className={labelClass}>{t('website.site.colours', 'Colours')}</span>
        <ColorField label={t('website.site.accent', 'Buttons and links')} value={doc.theme.accent} onChange={(accent) => setTheme({ accent }, 'accent')} />
        <ColorField label={t('website.site.background', 'Page background')} value={doc.theme.background} onChange={(background) => setTheme({ background }, 'background')} />
        <ColorField label={t('website.site.text', 'Text')} value={doc.theme.text} onChange={(text) => setTheme({ text }, 'text')} />
      </section>

      <section>
        <TextArea
          label={t('website.site.customCss', 'Custom CSS (advanced)')}
          value={doc.customCss}
          rows={8}
          mono
          maxLength={100 * 1024}
          helperText={t('website.site.customCssHint', 'Applied to every page after the site’s own styles. Imports and scripts are removed.')}
          onChange={(customCss) => update((d) => ({ ...d, customCss }), 'customCss')}
        />
      </section>
    </fieldset>
  );
};
