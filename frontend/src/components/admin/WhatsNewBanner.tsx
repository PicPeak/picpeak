/**
 * After-update "What's New" — a dismissible green bar that expands into a
 * modal. Driven by GET /admin/system/updates/whatsnew, which returns the
 * curated highlights for every version this instance moved through since it
 * last acknowledged one. Dismiss (X or "Got it") advances the per-instance
 * marker via POST .../seen, so it stops showing for everyone.
 *
 * Bullets are written once in the release CI (GitHub Models) and read from
 * the GitHub release notes — there's no AI at runtime. Releases without a
 * curated block fall back to their changelog "Features".
 */
import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Sparkles, X, ExternalLink, ChevronRight } from 'lucide-react';
import { adminService } from '../../services/admin.service';
import { useModal } from '../../hooks';

export const WhatsNewBanner: React.FC = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const detailsModal = useModal();
  const [hidden, setHidden] = useState(false);

  const { data } = useQuery({
    queryKey: ['whatsnew'],
    queryFn: () => adminService.getWhatsNew(),
    staleTime: 5 * 60 * 1000,
  });

  const seen = useMutation({
    mutationFn: () => adminService.markWhatsNewSeen(),
    onSuccess: () => {
      setHidden(true);
      detailsModal.close();
      qc.invalidateQueries({ queryKey: ['whatsnew'] });
    },
  });

  if (hidden || !data?.hasNews || !data.versions?.length) return null;

  // Inline teaser on the bar: the first few bullets across all new versions.
  const teaser = data.versions.flatMap((v) => v.bullets).slice(0, 3);

  return (
    <>
      <div className="bg-green-50 dark:bg-green-900/30 border-l-4 border-green-500 p-4 mb-4 rounded-r-lg">
        <div className="flex items-start justify-between">
          <div className="flex items-start">
            <Sparkles className="w-5 h-5 text-green-600 mt-0.5 mr-3 flex-shrink-0" />
            <div>
              <h4 className="text-sm font-semibold text-green-800 dark:text-green-200">
                {t('admin.whatsnew.title', "What's new in {{version}}", { version: data.toVersion })}
              </h4>
              <ul className="text-sm text-green-700 dark:text-green-300 mt-1 list-disc list-inside">
                {teaser.map((b, i) => <li key={i}>{b}</li>)}
              </ul>
              <div className="mt-2">
                <button
                  onClick={detailsModal.open}
                  className="inline-flex items-center text-xs font-medium text-white bg-green-600 hover:bg-green-700 px-3 py-1.5 rounded-md transition-colors"
                >
                  {t('admin.whatsnew.viewAll', "What's new")}
                  <ChevronRight className="w-3 h-3 ml-1" />
                </button>
              </div>
            </div>
          </div>
          <button
            onClick={() => seen.mutate()}
            className="text-green-500 hover:text-green-700 dark:hover:text-green-300 p-1"
            aria-label={t('common.close', 'Close')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {detailsModal.isOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={detailsModal.close}
        >
          <div
            className="bg-white dark:bg-neutral-800 rounded-lg shadow-xl max-w-lg w-full max-h-[80vh] overflow-auto p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold flex items-center gap-2 text-neutral-900 dark:text-neutral-100">
                <Sparkles className="w-5 h-5 text-green-600" />
                {t('admin.whatsnew.modalTitle', "What's new")}
              </h3>
              <button onClick={detailsModal.close} className="p-1 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-4">
              {data.versions.map((v) => (
                <div key={v.version}>
                  <div className="flex items-center justify-between gap-3">
                    <h4 className="font-medium text-sm text-neutral-900 dark:text-neutral-100">{v.name || `v${v.version}`}</h4>
                    <a
                      href={v.htmlUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-blue-600 dark:text-blue-400 inline-flex items-center whitespace-nowrap"
                    >
                      {t('admin.whatsnew.fullChangelog', 'Full changelog')}
                      <ExternalLink className="w-3 h-3 ml-1" />
                    </a>
                  </div>
                  <ul className="mt-1 list-disc list-inside text-sm text-neutral-700 dark:text-neutral-300">
                    {v.bullets.map((b, i) => <li key={i}>{b}</li>)}
                  </ul>
                </div>
              ))}
            </div>
            <div className="mt-6 flex justify-end">
              <button
                onClick={() => seen.mutate()}
                className="text-sm font-medium text-white bg-green-600 hover:bg-green-700 px-4 py-2 rounded-md transition-colors"
              >
                {t('admin.whatsnew.gotIt', 'Got it')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
