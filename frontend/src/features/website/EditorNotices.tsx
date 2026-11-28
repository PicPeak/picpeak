/**
 * What the builder says above the editor (issue 2618): that the admin may
 * only look, that a refresh failed, that someone else saved, what became of
 * an imported landing page, and that the website is not shown yet.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Notice } from '../../components/common';
import type { useWebsiteEditor } from './useWebsiteEditor';
import type { EditorState, ValidationProblem } from './types';

interface EditorNoticesProps {
  editor: ReturnType<typeof useWebsiteEditor>;
  server: EditorState;
  canEdit: boolean;
  /** May show or hide the website at the site root. */
  canSwitchSite: boolean;
  visibility: { isPending: boolean; mutate: (enabled: boolean) => void };
  takeOffline: () => Promise<void>;
  setProblems: (problems: ValidationProblem[]) => void;
}

export const EditorNotices: React.FC<EditorNoticesProps> = ({ editor, server, canEdit, canSwitchSite, visibility, takeOffline, setProblems }) => {
  const { t } = useTranslation();
  return (
    <>
      {!canEdit && <Notice tone="neutral" size="sm">{t('website.readOnly', 'You can see the website but not change it.')}</Notice>}
      {editor.query.isError && (
        <Notice
          tone="warning"
          size="sm"
          action={(
            <Button size="sm" variant="secondary" isLoading={editor.query.isFetching} onClick={() => { void editor.query.refetch(); }}>
              {t('common.retry', 'Try again')}
            </Button>
          )}
        >
          {t('website.refreshFailed', 'Could not refresh the website. Your changes here are kept.')}
        </Notice>
      )}
      {editor.conflict && (
        <Notice
          tone="warning"
          size="sm"
          action={(
            <Button size="sm" variant="secondary" onClick={() => { void editor.reloadLatest().then(() => setProblems([])); }}>
              {t('website.conflictReload', 'Load the latest version')}
            </Button>
          )}
        >
          {t('website.conflict', 'Someone else saved the website since you opened it, so your changes were not saved. Load the latest version to continue from theirs; your unsaved changes here are then dropped.')}
        </Notice>
      )}
      {server.legacyImportRefused && (
        <Notice tone="warning" size="sm">
          {t('website.importRefused', 'Your landing page is too long for a custom HTML block ({{length}} of {{max}} characters), so it was not copied into the builder; nothing of it was cut. It stays live at the site root until you publish here. To keep it, shorten it and paste it into a custom HTML block.', server.legacyImportRefused)}
        </Notice>
      )}
      {server.legacyLandingLive && (
        <Notice tone="info" size="sm"
          action={canSwitchSite && server.publicSiteEnabled ? (
            <Button size="sm" variant="ghost" isLoading={visibility.isPending} onClick={() => { void takeOffline(); }}>
              {t('website.landingOffline', 'Take the landing page offline')}
            </Button>
          ) : undefined}>
          {t('website.legacyImported', 'Your previous landing page was imported here. Visitors still see it unchanged at the site root; review it and publish when you are ready, and the website takes its place.')}
        </Notice>
      )}
      {!server.publicSiteEnabled && (
        <Notice tone="warning" size="sm"
          action={canSwitchSite ? (
            <Button size="sm" variant="secondary" isLoading={visibility.isPending} onClick={() => visibility.mutate(true)}>
              {t('website.showAtRoot', 'Show it at the site root')}
            </Button>
          ) : undefined}>
          {t('website.siteOff', 'The website is not shown at the site root yet: `/` leads to the gallery code page instead.')}
        </Notice>
      )}
    </>
  );
};
