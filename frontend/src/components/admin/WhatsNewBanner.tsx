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
import { Button, Modal, Notice } from '../common';

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
      <Notice
        tone="success"
        className="mb-4"
        icon={<Sparkles className="w-5 h-5" />}
        title={t('admin.whatsnew.title', "What's new in {{version}}", { version: data.toVersion })}
        action={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={detailsModal.open}
              rightIcon={<ChevronRight className="w-3 h-3" />}
            >
              {t('admin.whatsnew.viewAll', "What's new")}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => seen.mutate()}
              aria-label={t('common.close', 'Close')}
            >
              <X className="w-4 h-4" />
            </Button>
          </>
        }
      >
        <ul className="list-disc list-inside">
          {teaser.map((b, i) => <li key={i}>{b}</li>)}
        </ul>
      </Notice>

      <Modal
        open={detailsModal.isOpen}
        onClose={detailsModal.close}
        size="md"
        title={
          <span className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-success-text" />
            {t('admin.whatsnew.modalTitle', "What's new")}
          </span>
        }
        footer={
          <Button variant="primary" onClick={() => seen.mutate()}>
            {t('admin.whatsnew.gotIt', 'Got it')}
          </Button>
        }
      >
        <div className="space-y-4">
          {data.versions.map((v) => (
            <div key={v.version}>
              <div className="flex items-center justify-between gap-3">
                <h4 className="font-medium text-sm text-heading">{v.name || `v${v.version}`}</h4>
                <a
                  href={v.htmlUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-info-text inline-flex items-center whitespace-nowrap"
                >
                  {t('admin.whatsnew.fullChangelog', 'Full changelog')}
                  <ExternalLink className="w-3 h-3 ml-1" />
                </a>
              </div>
              <ul className="mt-1 list-disc list-inside text-sm text-body">
                {v.bullets.map((b, i) => <li key={i}>{b}</li>)}
              </ul>
            </div>
          ))}
        </div>
      </Modal>
    </>
  );
};
