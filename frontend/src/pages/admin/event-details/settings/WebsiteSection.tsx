/**
 * The gallery's opt-in for the public website (issue 2618). A setting: it
 * changes the draft and saves with the save bar. Shown only while the
 * website builder is on.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { Event } from '../../../../types';
import { Notice, Switch } from '../../../../components/common';
import { usePermission } from '../../../../hooks/usePermission';
import { normalizeRequirePassword } from '../../../../utils/accessControl';
import type { EventFields } from './draft';
import { SectionCard } from './sections';

export const WebsiteSection: React.FC<{
  f: EventFields;
  set: (patch: Partial<EventFields>) => void;
  event: Event;
  readOnly: boolean;
}> = ({ f, set, event, readOnly }) => {
  const { t } = useTranslation();
  const canOpenBuilder = usePermission('cms.view');
  const canEditWebsite = usePermission('cms.edit');
  // The owner's switch, as the password is (the server refuses anyone else);
  // an older payload without the field is read as the owner's.
  const ownsEvent = event.can_manage_assignments !== false;
  const hasPassword = normalizeRequirePassword(event.require_password, true);
  return (
    <SectionCard>
      <Switch
        checked={f.show_on_website}
        disabled={readOnly || !ownsEvent || !canEditWebsite}
        onChange={(show_on_website) => set({ show_on_website })}
        label={t('events.website.toggle', 'Show on public website')}
        description={t('events.website.help', 'Lets you pick photos of this gallery for your website and list it among the featured galleries. Only the photos you pick appear there. Switch it off and they leave the website at once.')}
      />
      {!ownsEvent && (
        <p className="text-xs text-muted">{t('events.website.ownerOnly', 'Only the gallery owner can put it on the website.')}</p>
      )}
      {ownsEvent && !canEditWebsite && (
        <p className="text-xs text-muted">{t('events.website.needsCmsEdit', 'Changing the website needs the permission to edit it.')}</p>
      )}
      {f.show_on_website && (
        <p className="text-xs text-muted">{t('events.website.watermarkNote', 'Photos from this gallery appear with its watermark; upload images directly for a clean portfolio.')}</p>
      )}
      {f.show_on_website && hasPassword && (
        <Notice tone="warning" size="sm">
          {t('events.website.passwordNotice', 'This gallery has a password. While this is on, the photos you pick for the website are public, although this gallery has a password; the rest of the gallery keeps its password.')}
        </Notice>
      )}
      {canOpenBuilder && (
        <Link to="/admin/website" className="inline-block text-sm text-accent hover:underline">
          {t('events.website.openBuilder', 'Open the website builder')}
        </Link>
      )}
    </SectionCard>
  );
};
