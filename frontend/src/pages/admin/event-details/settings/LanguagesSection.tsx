/**
 * Multilingual gallery texts (issue 2550): the mode, the gallery's languages
 * and the title in each of them. The welcome message's languages sit on the
 * welcome message (General), category names and chapter markers on the
 * categories (Photos). Every text is written by hand; nothing is translated
 * automatically.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../../../../components/common/Button';
import { useConfirm } from '../../../../components/common/ConfirmDialog';
import { translationsQueryKey, translationsService } from '../../../../services/translations.service';
import type { Event, TextLanguageMode } from '../../../../types';
import { languageName, TEXT_LANGUAGES, TranslatableField, translationLanguages } from '../../../../components/admin/TranslatableField';
import { SectionCard, inputClass, labelClass, type FieldsProps } from './sections';
import { textsOfField, type EventTextsDraft } from './draft';

const selectClass = 'w-full px-3 py-2 border border-line-strong bg-panel text-heading rounded-md shadow-sm focus:ring-accent focus:border-accent-dark text-sm disabled:bg-inset';

export const LanguagesSection: React.FC<FieldsProps & {
  event: Pick<Event, 'id' | 'event_name'>;
  texts: EventTextsDraft | null;
  setTexts: (patch: Record<string, string>) => void;
}> = ({ f, set, event, texts, setTexts }) => {
  const { t, i18n } = useTranslation();
  const mode = f.text_language_mode;
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [removing, setRemoving] = React.useState(false);

  // Translations written in the language now chosen as the first one (the
  // primary changed after they were written). The gallery shows the stored
  // texts for the first language, so these stay hidden; say so, and let the
  // admin remove them. Switching the first language back uses them again.
  const { data: textState } = useQuery({
    queryKey: translationsQueryKey(event.id),
    queryFn: () => translationsService.get(event.id),
    enabled: mode !== 'off',
  });
  const hiddenRows = mode !== 'off' && f.text_primary_language
    ? (textState?.translations || []).filter((row) => row.language === f.text_primary_language)
    : [];
  const removeHidden = async () => {
    const ok = await confirm({
      message: t('events.languages.hiddenRemoveConfirm', 'Remove the {{count}} translations written in {{language}}? This cannot be undone.',
        { count: hiddenRows.length, language: languageName(f.text_primary_language) }),
      variant: 'danger',
    });
    if (!ok) return;
    setRemoving(true);
    try {
      await translationsService.save(event.id, hiddenRows.map((row) => ({
        entity_type: row.entity_type, entity_id: row.entity_id, field: row.field, language: row.language, text: null,
      })));
      await queryClient.invalidateQueries({ queryKey: translationsQueryKey(event.id) });
    } finally {
      setRemoving(false);
    }
  };
  const fallbackPrimary = TEXT_LANGUAGES.includes(i18n.language.split('-')[0]) ? i18n.language.split('-')[0] : 'en';

  const chooseMode = (next: TextLanguageMode) => {
    const primary = f.text_primary_language || (next === 'off' ? null : fallbackPrimary);
    const secondary = next === 'bilingual'
      ? (f.text_secondary_language && f.text_secondary_language !== primary
        ? f.text_secondary_language
        : TEXT_LANGUAGES.find((code) => code !== primary) ?? null)
      : f.text_secondary_language;
    set({ text_language_mode: next, text_primary_language: primary, text_secondary_language: secondary });
  };

  const modes: Array<{ value: TextLanguageMode; label: string; help: string }> = [
    { value: 'off', label: t('events.languages.modeOff', 'One language'), help: t('events.languages.modeOffHelp', 'The texts as you typed them, for every visitor.') },
    { value: 'visitor', label: t('events.languages.modeVisitor', 'Visitor\'s language'), help: t('events.languages.modeVisitorHelp', 'Each visitor reads the texts in the language their browser asks for, when you wrote one; otherwise in the gallery\'s language. Visitors can switch the language in the gallery.') },
    { value: 'bilingual', label: t('events.languages.modeBilingual', 'Two languages together'), help: t('events.languages.modeBilingualHelp', 'The title, the welcome message and the chapter markers show both languages: the first one large, the second one smaller below it. Category names show the first language.') },
  ];

  return (
    <>
      <SectionCard description={t('events.languages.intro', 'Write the gallery texts in more than one language. You write every translation yourself; nothing is translated automatically.')}>
        <fieldset>
          <legend className={labelClass}>{t('events.languages.mode', 'Gallery texts')}</legend>
          <div className="space-y-2 mt-1">
            {modes.map((option) => (
              <label
                key={option.value}
                className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer ${
                  mode === option.value ? 'border-accent bg-accent-soft' : 'border-line hover:bg-hover'
                }`}
              >
                <input
                  type="radio"
                  name="text-language-mode"
                  value={option.value}
                  checked={mode === option.value}
                  onChange={() => chooseMode(option.value)}
                  className="mt-1 text-accent focus:ring-accent"
                  aria-labelledby={`text-language-mode-${option.value}`}
                  aria-describedby={`text-language-mode-${option.value}-help`}
                />
                <span>
                  <span id={`text-language-mode-${option.value}`} className={`block text-sm font-medium ${mode === option.value ? 'text-on-accent-soft' : 'text-heading'}`}>{option.label}</span>
                  <span id={`text-language-mode-${option.value}-help`} className={`block text-xs mt-0.5 ${mode === option.value ? 'text-on-accent-soft' : 'text-muted'}`}>{option.help}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {mode !== 'off' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelClass} htmlFor="text-primary-language">
                {mode === 'bilingual'
                  ? t('events.languages.primary', 'First language (large)')
                  : t('events.languages.default', 'Language of your texts')}
              </label>
              <select
                id="text-primary-language"
                value={f.text_primary_language ?? ''}
                onChange={(e) => set({ text_primary_language: e.target.value || null })}
                className={selectClass}
              >
                {TEXT_LANGUAGES.map((code) => <option key={code} value={code}>{languageName(code)}</option>)}
              </select>
              <p className="text-xs text-muted mt-1">
                {t('events.languages.defaultHelp', 'The language you wrote the title, welcome message and category names in. Visitors without a translation in their language see these texts.')}
              </p>
            </div>
            {mode === 'bilingual' && (
              <div>
                <label className={labelClass} htmlFor="text-secondary-language">{t('events.languages.secondary', 'Second language (smaller)')}</label>
                <select
                  id="text-secondary-language"
                  value={f.text_secondary_language ?? ''}
                  onChange={(e) => set({ text_secondary_language: e.target.value || null })}
                  className={selectClass}
                >
                  {TEXT_LANGUAGES.filter((code) => code !== f.text_primary_language)
                    .map((code) => <option key={code} value={code}>{languageName(code)}</option>)}
                </select>
              </div>
            )}
          </div>
        )}

        {hiddenRows.length > 0 && (
          <div className="rounded-lg border border-warning-line bg-warning-soft p-4 space-y-3" data-testid="hidden-primary-translations">
            <p className="text-sm text-warning-text">
              {t('events.languages.hiddenNotice', '{{count}} texts have a translation in {{language}}. While {{language}} is the first language, the gallery shows your original texts instead and these translations stay hidden. Switch the first language back to use them again, or remove them.',
                { count: hiddenRows.length, language: languageName(f.text_primary_language) })}
            </p>
            <Button variant="outline" size="sm" onClick={removeHidden} disabled={removing}>
              {t('events.languages.hiddenRemove', 'Remove these translations')}
            </Button>
          </div>
        )}
      </SectionCard>

      {mode !== 'off' && (
        <SectionCard
          title={t('events.languages.textsTitle', 'Title')}
          description={t('events.languages.textsHelp', 'Pick a language tab to write the title in it. The welcome message has the same tabs under General, category names and chapter markers under Photos → Categories.')}
        >
          {texts ? (
            <TranslatableField
              id="settings-title-translations"
              label={t('events.languages.titleLabel', 'Gallery title')}
              primary={f.text_primary_language}
              languages={translationLanguages(mode, f.text_primary_language, f.text_secondary_language)}
              value={event.event_name}
              defaultHint={t('events.languages.titleRenameHint', 'Rename the gallery with the pencil next to its name at the top of the page.')}
              translations={textsOfField(texts, 'event_name')}
              onTranslationChange={(language, text) => setTexts({ [`event_name:${language}`]: text })}
              maxLength={255}
              inputClassName={inputClass}
              labelClassName={labelClass}
            />
          ) : (
            <p className="text-sm text-muted">{t('common.loading', 'Loading...')}</p>
          )}
        </SectionCard>
      )}
    </>
  );
};
