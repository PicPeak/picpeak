import React from 'react';
import { Info, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// Hard-coded "feature flag" — flip to false (or remove this component from
// AdminLayout) once the migration window settles, after operators have had
// ~1 quarter to update their docker-compose.yml. See #669.
const MIGRATION_BANNER_ENABLED = true;

// localStorage key — versioned (`:v1`) so a future "we've moved again" banner
// can show without inheriting the user's earlier dismissal.
const DISMISS_KEY = 'picpeak:migration-banner:v1';

/**
 * One-time migration banner shown at the top of the admin layout (#669).
 *
 * Surfaces the org rename + new GHCR registry path so an operator who hasn't
 * read the release notes sees the change when they next log in. Dismissible
 * per-admin via localStorage; the toggle above can flip it off globally.
 */
export const MigrationBanner: React.FC = () => {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = React.useState<boolean>(() => {
    try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
  });

  if (!MIGRATION_BANNER_ENABLED || dismissed) return null;

  const handleDismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* localStorage blocked */ }
    setDismissed(true);
  };

  return (
    <div className="bg-blue-50 dark:bg-blue-900/20 border-b border-blue-200 dark:border-blue-800">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-start justify-between gap-3 py-3">
          <div className="flex items-start gap-3 min-w-0">
            <Info className="w-5 h-5 text-blue-600 dark:text-blue-300 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-blue-900 dark:text-blue-100 min-w-0">
              <p className="font-medium">{t('migrationBanner.title', "PicPeak's image registry has moved")}</p>
              <p className="text-blue-800 dark:text-blue-200 mt-0.5">
                {t('migrationBanner.body', {
                  defaultValue: 'Update your docker-compose.yml to pull from {{newPath}} — the old path is no longer being updated.',
                  newPath: 'ghcr.io/picpeak/picpeak/{backend,frontend}',
                })}{' '}
                <a
                  href="https://github.com/PicPeak/picpeak/blob/main/docs/migration-to-org.md"
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:no-underline"
                >
                  {t('migrationBanner.link', 'See migration notes')}
                </a>
              </p>
            </div>
          </div>
          <button
            onClick={handleDismiss}
            className="text-blue-600 dark:text-blue-300 hover:text-blue-700 dark:hover:text-blue-200 flex-shrink-0"
            aria-label={t('common.dismiss', 'Dismiss')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  );
};
