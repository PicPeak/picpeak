import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import catalog from './usageFeatures.v2.json';

/** Local, static disclosure: opening it never contacts the collector. */
export function UsageCatalog() {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const entries = Object.entries(catalog.features).filter(([key]) =>
    `${key} ${t(`productUsage.catalog.${key}.name`)}`.toLowerCase().includes(search.toLowerCase()));
  return (
    <details className="rounded border border-theme p-3">
      <summary className="cursor-pointer font-semibold">{t('productUsage.catalogTitle')}</summary>
      <p className="my-3 text-sm">{t('productUsage.catalogExplanation')}</p>
      <label className="block text-sm">
        {t('productUsage.catalogSearch')}
        <input type="search" value={search} onChange={(e) => setSearch(e.target.value)}
          className="my-2 w-full rounded border border-theme bg-theme-surface p-2" />
      </label>
      <div className="max-h-96 space-y-3 overflow-y-auto" tabIndex={0}>
        {entries.map(([key, definition]) => (
          <section key={key} className="border-t border-theme pt-2">
            <h4 className="font-semibold">{t(`productUsage.catalog.${key}.name`)}</h4>
            <p className="text-xs"><code>{key}</code> · {definition.since}</p>
            <p className="text-sm">{t('productUsage.configuredLabel')}: {t(`productUsage.catalog.${key}.configured`)}</p>
            <p className="text-sm">{definition.used
              ? `${t('productUsage.usedLabel')}: ${t(`productUsage.catalog.${key}.used`)}`
              : t('productUsage.configurationOnly')}</p>
          </section>
        ))}
        {!entries.length && <p>{t('productUsage.catalogEmpty')}</p>}
      </div>
    </details>
  );
}
