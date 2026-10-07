/**
 * The gallery's Settings tab: every setting of the gallery in sections, one
 * draft, one Save bar (SettingsSaveBar). Replaces the old view/edit toggle,
 * where some cards saved behind Edit and others saved themselves.
 *
 * Split view (issue 1765, draft E5): the sections as a grouped overview on
 * the left, each with a line of its current state, and the selected section
 * edited on the right. Below `lg` the overview is the page and a section
 * opens full-screen with a back arrow; opening one there adds a history
 * entry, so the browser's Back returns to the overview too.
 *
 * Sections the admin may not change render read-only (a disabled fieldset);
 * the backend enforces the same permissions on every endpoint.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Archive, ArrowLeft, Trash2, Undo2 } from 'lucide-react';
import type { Event } from '../../../../types';
import { Button } from '../../../../components/common';
import { SettingsSaveBar } from '../../../../components/admin/SettingsSaveBar';
import { FaceRecognitionCard } from '../../../../components/admin/FaceRecognitionCard';
import { useConfirm } from '../../../../components/common/ConfirmDialog';
import { useFillViewport } from '../../../../components/admin/fillViewport';
import { useFeatureFlags } from '../../../../contexts/FeatureFlagsContext';
import { usePermissions } from '../../../../contexts/PermissionsContext';
import { useLocalizedDate } from '../../../../hooks/useLocalizedDate';
import type { AdminPhoto } from '../../../../services/photos.service';
import type { EventFields, SettingsSectionKey } from './draft';
import type { EventSettingsDraftApi } from './useEventSettingsDraft';
import { AccessSection, GeneralSection, GuestsSection, ReminderSection, SectionCard, SourceSection } from './sections';
import { DownloadsSection } from './DownloadsSection';
import { AppearanceSection } from './AppearanceSection';
import { SlideshowSection } from './SlideshowSection';
import { DeliverySection } from './DeliverySection';
import { safeParseDate } from '../utils';
import { SECTION_ICON, SettingsOverview, useSectionSummaries } from './SettingsOverview';

export interface EventSettingsTabProps {
  event: Event;
  settings: EventSettingsDraftApi;
  /** The section opened through the URL, or null when none was. */
  section: SettingsSectionKey | null;
  setSection: (section: SettingsSectionKey | null, options?: { push?: boolean }) => void;
  categories: Array<{ id: number; name: string }>;
  photos: AdminPhoto[];
  phoneFieldEnabled: boolean;
  onArchive: () => void;
  isArchiving: boolean;
  onDelete: () => void;
  isDeleting: boolean;
  refetchEvent: () => void;
}

const LG_QUERY = '(min-width: 1024px)';

/** Tailwind's `lg` and up, where the overview and the section sit side by side. */
const canMatch = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function';

function useSideBySide(): boolean {
  // No matchMedia (tests, old webviews): assume the desktop layout.
  const [matches, setMatches] = useState(() => (canMatch() ? window.matchMedia(LG_QUERY).matches : true));
  useEffect(() => {
    if (!canMatch()) return undefined;
    const query = window.matchMedia(LG_QUERY);
    const onChange = () => setMatches(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return matches;
}

export const EventSettingsTab: React.FC<EventSettingsTabProps> = ({
  event, settings, section, setSection, categories, photos, phoneFieldEnabled,
  onArchive, isArchiving, onDelete, isDeleting, refetchEvent,
}) => {
  const { t } = useTranslation();
  const { flags, isLoading: flagsLoading } = useFeatureFlags();
  const { hasPermission, isLoading: permissionsLoading } = usePermissions();
  const { format } = useLocalizedDate();
  const confirm = useConfirm();
  const { draft, setDraft, setEvent, dirty, isDirty, isSaving, save, discard, discardSection, downloadsData } = settings;

  const archived = Boolean(event.is_archived);
  const canEdit = hasPermission('events.edit') && !archived;

  const sections: Array<{ key: SettingsSectionKey; label: string; show: boolean }> = [
    { key: 'general', label: t('events.settingsTab.general', 'General'), show: true },
    { key: 'access', label: t('events.settingsTab.access', 'Access'), show: true },
    { key: 'downloads', label: t('events.settingsTab.downloads', 'Downloads'), show: true },
    { key: 'guests', label: t('events.settingsTab.guests', 'Guest interaction'), show: true },
    { key: 'appearance', label: t('events.settingsTab.appearance', 'Appearance'), show: true },
    { key: 'source', label: t('events.settingsTab.source', 'Photo source'), show: true },
    { key: 'delivery', label: t('events.settingsTab.delivery', 'Folders & delivery'), show: true },
    { key: 'reminder', label: t('eventReminderOverride.title', 'Pre-event reminder'), show: !!flags.reminderEmails },
    { key: 'slideshow', label: t('slideshow.adminTitle', 'Live Slideshow'), show: !!flags.slideshow },
    { key: 'faces', label: t('events.settingsTab.faces', 'Faces'), show: !!flags.faces },
    { key: 'danger', label: t('events.settingsTab.danger', 'Danger zone'), show: !archived && (hasPermission('events.archive') || hasPermission('events.delete')) },
  ];
  const visible = sections.filter((s) => s.show);
  const opened = section && visible.some((s) => s.key === section) ? section : null;
  // Side by side, nothing opened means General. On a phone it means the overview.
  const active: SettingsSectionKey = opened ?? 'general';
  const sideBySide = useSideBySide();
  const phoneOpen = opened !== null;
  const location = useLocation();
  const navigate = useNavigate();
  // Side by side, the overview and the section scroll on their own under
  // the tabs; the page head and the save bar stay put.
  useFillViewport();

  const set = (patch: Partial<EventFields>) => setEvent((prev) => ({ ...prev, ...patch }));

  // A link to a section the flags hide (or the role can't see) falls back
  // to nothing opened, and the URL stops naming it. Only once flags and
  // permissions have loaded: until then the defaults hide Faces, Slideshow,
  // Reminder and Danger zone, and a reload on one of them would lose it.
  useEffect(() => {
    if (section && !opened && !flagsLoading && !permissionsLoading) setSection(null);
  }, [section, opened, flagsLoading, permissionsLoading, setSection]);

  // On a phone, opening a section from the overview adds a history entry.
  const open = (key: SettingsSectionKey) => setSection(key, { push: !sideBySide && !opened });

  // Back to the overview: undo our own history entry when there is one, so
  // the browser's Back and this arrow agree; otherwise just close.
  const overviewRef = useRef<HTMLDivElement>(null);
  const lastOpened = useRef<SettingsSectionKey | null>(null);
  const closeSection = () => {
    lastOpened.current = opened;
    if ((location.state as { settingsSectionPushed?: boolean } | null)?.settingsSectionPushed) navigate(-1);
    else setSection(null);
  };
  // The arrow hides its own container, so focus goes back to the row it came from.
  useEffect(() => {
    if (opened || !lastOpened.current) return;
    overviewRef.current?.querySelector<HTMLButtonElement>(`[data-section="${lastOpened.current}"]`)?.focus();
    lastOpened.current = null;
  }, [opened]);

  // The detail half is its own scroll pane: a newly opened section starts at
  // its top, header in view, also after the save's jump to an invalid one.
  const detailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (detailRef.current) detailRef.current.scrollTop = 0;
  }, [active]);

  const onSave = async () => {
    const { invalidSection } = await save();
    if (invalidSection) open(invalidSection);
  };

  // The date the reminder goes out, when this gallery sets its own offset.
  const reminderDate = (() => {
    const eventDate = safeParseDate(event.event_date);
    const offset = draft.event.event_reminder_offset_days.trim();
    if (!eventDate || offset === '' || !Number.isFinite(Number(offset))) return null;
    const d = new Date(eventDate);
    d.setDate(d.getDate() - Math.floor(Number(offset)));
    return format(d, 'PP');
  })();

  const summaries = useSectionSummaries(event, draft, reminderDate);
  const activeLabel = visible.find((s) => s.key === active)?.label ?? '';
  const ActiveIcon = SECTION_ICON[active];
  const about: Record<SettingsSectionKey, string> = {
    general: t('events.settingsTab.about.general', 'Customer, client accounts and the welcome message.'),
    appearance: t('events.settingsTab.about.appearance', 'Hero photo, logo, banners and the look of the gallery.'),
    access: t('events.settingsTab.about.access', 'Who can open the gallery, and until when.'),
    downloads: t('events.settingsTab.about.downloads', 'What guests may download, in which size, and how photos are protected.'),
    guests: t('events.settingsTab.about.guests', 'Guest uploads, names and feedback.'),
    slideshow: t('events.settingsTab.about.slideshow', 'A fullscreen link for projectors at live events.'),
    source: t('events.settingsTab.about.source', 'Where the photos of this gallery come from.'),
    delivery: t('events.settingsTab.about.delivery', 'Nested folders from uploads, and delivering a first look before the full gallery.'),
    reminder: t('events.settingsTab.about.reminder', 'The reminder email to the customer before the event.'),
    faces: t('events.settingsTab.about.faces', 'Find and group the people in the photos.'),
    danger: t('events.settingsTab.about.danger', 'Archive or delete this gallery.'),
  };

  const body = (() => {
    switch (active) {
      case 'general':
        return <GeneralSection f={draft.event} set={set} phoneFieldEnabled={phoneFieldEnabled} event={event} />;
      case 'access':
        return <AccessSection f={draft.event} set={set} />;
      case 'downloads':
        return (
          <DownloadsSection
            f={draft.event}
            set={set}
            downloads={draft.downloads}
            setDownloads={(downloads) => setDraft((d) => ({ ...d, downloads }))}
            downloadsData={downloadsData}
          />
        );
      case 'guests':
        return (
          <GuestsSection
            f={draft.event}
            set={set}
            categories={categories}
            feedback={draft.feedback}
            setFeedback={(feedback) => setDraft((d) => ({ ...d, feedback }))}
          />
        );
      case 'appearance':
        return <AppearanceSection f={draft.event} set={set} event={event} photos={photos} readOnly={!canEdit} />;
      case 'source':
        return <SourceSection f={draft.event} set={set} event={event} canEdit={canEdit} />;
      case 'delivery':
        return <DeliverySection f={draft.event} set={set} event={event} onChanged={refetchEvent} />;
      case 'reminder':
        return (
          <ReminderSection
            f={draft.event}
            set={set}
            reminderDate={reminderDate}
            recipient={event.customer_email || null}
          />
        );
      case 'slideshow':
        return (
          <SlideshowSection
            event={event}
            style={draft.slideshow}
            setStyle={(slideshow) => setDraft((d) => ({ ...d, slideshow }))}
            canAct={canEdit}
            onLinkChanged={refetchEvent}
          />
        );
      case 'faces':
        // Face recognition is a set of jobs (detect, rescan, recluster,
        // delete) rather than settings, so it acts immediately.
        return <FaceRecognitionCard eventId={event.id} isArchived={archived} bare />;
      case 'danger':
        return (
          <SectionCard>
            {hasPermission('events.archive') && (
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-heading">{t('events.archiveEvent')}</p>
                  <p className="text-xs text-muted">{t('events.archivingInfo')}</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  leftIcon={<Archive className="w-4 h-4" />}
                  isLoading={isArchiving}
                  onClick={async () => {
                    if (await confirm({ message: t('events.archiveConfirm'), variant: 'danger' })) onArchive();
                  }}
                >
                  {t('events.archiveEvent')}
                </Button>
              </div>
            )}
            {hasPermission('events.delete') && (
              <div className="flex items-start justify-between gap-4 pt-4 border-t border-line">
                <div>
                  <p className="text-sm font-medium text-heading">{t('events.settingsTab.deleteTitle', 'Delete gallery')}</p>
                  <p className="text-xs text-muted">{t('events.settingsTab.deleteHelp', 'Removes the gallery and its photos for good. This cannot be undone.')}</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-red-600 dark:text-red-400 border-red-300 dark:border-red-800"
                  leftIcon={<Trash2 className="w-4 h-4" />}
                  isLoading={isDeleting}
                  onClick={async () => {
                    const ok = await confirm({
                      title: t('events.settingsTab.deleteTitle', 'Delete gallery'),
                      message: t('events.settingsTab.deleteConfirm', 'Delete "{{name}}" and all its photos? This cannot be undone.', { name: event.event_name }),
                      variant: 'danger',
                    });
                    if (ok) onDelete();
                  }}
                >
                  {t('common.delete', 'Delete')}
                </Button>
              </div>
            )}
          </SectionCard>
        );
      default:
        return null;
    }
  })();

  // Faces and the danger zone act immediately; everything else is a draft.
  const readOnlyHint = !canEdit && active !== 'faces' && active !== 'danger';

  return (
    // From lg this fills the space under the tabs (see useFillViewport), and
    // the two halves are its scroll panes. The gap under the tabs and above
    // the bottom is padding inside the panes, so their content scrolls right
    // up to the tabs' line and down to the save bar. No height floor: a floor
    // made the panes overflow <main> on a short window, where the pinned save
    // bar then covered their last rows. On a short window the panes are just
    // shorter, and still scroll (205px at 1280x600 with the expiry banner).
    <div className="lg:flex-1 lg:min-h-0">
      <div className="grid grid-cols-1 lg:h-full lg:grid-cols-[minmax(280px,340px)_minmax(0,1fr)] xl:grid-cols-[380px_minmax(0,1fr)] 2xl:grid-cols-[420px_minmax(0,1fr)] gap-6 xl:gap-8 2xl:gap-10">
        <div ref={overviewRef} className={`${phoneOpen ? 'hidden lg:block' : ''} lg:min-h-0 lg:overflow-y-auto lg:pr-1 lg:pt-6 lg:pb-8`}>
          <SettingsOverview
            sections={visible}
            active={sideBySide ? active : opened}
            onSelect={open}
            dirty={dirty}
            summaries={summaries}
          />
        </div>

        <div ref={detailRef} data-testid="settings-detail-pane" className={`${phoneOpen ? '' : 'hidden lg:block'} min-w-0 lg:min-h-0 lg:overflow-y-auto lg:pt-6 lg:pb-8`}>
          {/* The card's cap is the form's width: the form fills the card, so
              the padding is the same on both sides and a wide display does not
              leave the card running empty past its fields. From 2xl the card,
              the padding and the gaps grow a step. Side by side its top lines
              up with the first section row, below the first group's heading
              (h-4 + mb-2 in SettingsOverview). */}
          <div className="lg:mt-6 lg:max-w-[52rem] 2xl:max-w-[60rem] bg-panel border border-line rounded-xl">
            <div className="flex flex-wrap items-start gap-3 px-5 sm:px-7 2xl:px-10 py-4 2xl:py-5 border-b border-line">
              <button
                type="button"
                onClick={closeSection}
                className="lg:hidden -ml-1 p-1 rounded-lg text-soft hover:bg-hover"
                aria-label={t('events.settingsTab.backToSections', 'All settings')}
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              <ActiveIcon className={`w-5 h-5 mt-0.5 shrink-0 ${active === 'danger' ? 'text-red-600 dark:text-red-400' : 'text-soft'}`} aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <h2 className={`text-lg font-semibold ${active === 'danger' ? 'text-red-600 dark:text-red-400' : 'text-heading'}`}>{activeLabel}</h2>
                <p className="text-sm text-soft mt-0.5">{about[active]}</p>
              </div>
              {canEdit && dirty.has(active) && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-amber-700 dark:text-amber-400"
                  leftIcon={<Undo2 className="w-4 h-4" />}
                  onClick={() => discardSection(active)}
                >
                  {t('events.settingsTab.undoSection', 'Undo changes in this section')}
                </Button>
              )}
            </div>

            <div className="px-5 sm:px-7 2xl:px-10 py-6 2xl:py-8 space-y-4">
              {readOnlyHint && (
                <p className="text-sm rounded-lg border border-line bg-inset text-body px-4 py-3">
                  {archived
                    ? t('events.settingsTab.readOnlyArchived', 'This gallery is archived. Its settings can no longer be changed.')
                    : t('events.settingsTab.readOnly', 'You can see these settings but not change them.')}
                </p>
              )}
              <fieldset disabled={readOnlyHint} className="min-w-0">
                {body}
              </fieldset>
            </div>
          </div>
        </div>
      </div>

      {/* Nothing to save for a role that may not change settings. */}
      {canEdit && (
      <SettingsSaveBar
        isDirty={isDirty}
        isSaving={isSaving}
        onSave={onSave}
        onDiscard={discard}
        canSave={canEdit}
        extra={isDirty ? (
          <span className="text-xs text-soft mr-2">
            {visible.filter((s) => dirty.has(s.key)).map((s) => s.label).join(', ')}
          </span>
        ) : undefined}
      />
      )}
    </div>
  );
};
