/**
 * Site-wide look of the website (issue 2618). Everything starts from the
 * gallery branding (logo, palette, fonts, button style); a value set here
 * overrides it for the website only.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { fontsService } from '../../services/fonts.service';
import { settingsTabHref } from '../settings/settingsNav';
import { ChoiceField, ColorField, SelectField, TextArea, labelClass } from './fields';
import { FooterSection } from './FooterSection';
import { MenuSection } from './MenuSection';
import type { WebsiteDocument, WebsiteTheme } from './types';

interface SitePanelProps {
  doc: WebsiteDocument;
  update: (fn: (doc: WebsiteDocument) => WebsiteDocument, field?: string) => void;
  readOnly: boolean;
}

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
        <Link to={`${settingsTabHref('branding')}#fonts`} className="inline-flex items-center gap-1 text-sm text-accent hover:underline">
          {t('website.site.manageFonts', 'Manage fonts')}
          <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
        </Link>
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

      <MenuSection doc={doc} update={update} readOnly={readOnly} />
      <FooterSection doc={doc} update={update} readOnly={readOnly} />

      <section>
        <TextArea
          label={t('website.site.customCss', 'Custom CSS (advanced)')}
          value={doc.customCss}
          rows={8}
          mono
          helperText={t('website.site.customCssHint', 'Applied to every page after the site’s own styles. Imports and scripts are removed.')}
          onChange={(customCss) => update((d) => ({ ...d, customCss }), 'customCss')}
        />
      </section>
    </fieldset>
  );
};
