/**
 * The left half of the gallery Settings tab (issue 1765, draft E5): every
 * section as a row with one line of its current state, in small groups, so
 * the list reads as an overview of the gallery rather than as a menu. The
 * selected section is edited on the right; on a phone the list is the page
 * and a section opens full-screen.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle, Bell, ChevronRight, Download, FolderOpen, FolderTree, Lock, MonitorPlay,
  Palette, ScanFace, SlidersHorizontal, Users, type LucideIcon,
} from 'lucide-react';
import type { Event } from '../../../../types';
import { useLocalizedDate } from '../../../../hooks/useLocalizedDate';
import type { EventSettingsDraft, SettingsSectionKey } from './draft';
import { safeParseDate } from '../utils';

export const SECTION_ICON: Record<SettingsSectionKey, LucideIcon> = {
  general: SlidersHorizontal,
  appearance: Palette,
  access: Lock,
  downloads: Download,
  guests: Users,
  slideshow: MonitorPlay,
  source: FolderOpen,
  delivery: FolderTree,
  reminder: Bell,
  faces: ScanFace,
  danger: AlertTriangle,
};

/** Most used first; the danger zone is not in a group, it closes the list. */
export const SECTION_GROUPS: Array<{ key: string; label: string; sections: SettingsSectionKey[] }> = [
  { key: 'basics', label: 'Basics', sections: ['general', 'appearance'] },
  { key: 'access', label: 'Access & downloads', sections: ['access', 'downloads'] },
  { key: 'guests', label: 'Guests', sections: ['guests', 'slideshow'] },
  { key: 'photos', label: 'Photos & automation', sections: ['source', 'delivery', 'reminder', 'faces'] },
];

type Tone = 'plain' | 'strong' | 'ok' | 'off';
interface Part { text: string; tone?: Tone }

const TONE_CLASS: Record<Tone, string> = {
  plain: '',
  strong: 'text-body font-medium',
  ok: 'text-success-text',
  off: 'text-muted',
};

/**
 * One line per section saying what it is set to, from the draft — so an
 * unsaved change shows in the list before it is saved — plus whether the
 * section only follows the global setting ("Default").
 */
export function useSectionSummaries(
  event: Event,
  draft: EventSettingsDraft,
  reminderDate: string | null,
): Record<SettingsSectionKey, { parts: Part[]; isDefault?: boolean }> {
  const { t } = useTranslation();
  const { format } = useLocalizedDate();
  const f = draft.event;
  const expires = safeParseDate(f.expires_at);
  const accounts = f.customer_accounts.length;
  const teamMembers = f.assigned_admins.length;
  const offset = f.event_reminder_offset_days.trim();
  const reminderInherits = !f.event_reminder_disabled && offset === '' && f.event_reminder_body_override.trim() === '';
  const s = (key: string, fallback: string, opts?: Record<string, unknown>) =>
    t(`events.settingsTab.summary.${key}`, fallback, opts) as string;

  return {
    general: {
      parts: [
        { text: f.customer_name.trim() || s('noCustomerName', 'No customer name'), tone: f.customer_name.trim() ? 'strong' : 'off' },
        ...(f.welcome_message.trim() ? [{ text: s('welcomeSet', 'welcome message set') }] : []),
        ...(accounts > 0 ? [{ text: s('clientAccounts', '{{count}} client accounts', { count: accounts }) }] : []),
        // Gallery team (issue 743).
        ...(teamMembers > 0 ? [{ text: s('teamMembers', '{{count}} team members', { count: teamMembers }) }] : []),
        ...(f.review_contributor_uploads ? [{ text: s('teamReview', 'team uploads reviewed') }] : []),
      ],
    },
    appearance: {
      parts: [{ text: f.custom_theme_enabled ? s('ownStyling', 'Own styling') : s('globalTheme', 'Global theme') }],
      isDefault: !f.custom_theme_enabled,
    },
    access: {
      parts: [
        f.require_password
          ? { text: s('passwordOn', 'Password on'), tone: 'strong' }
          : { text: s('passwordOff', 'No password'), tone: 'off' },
        { text: expires ? s('expires', 'expires {{date}}', { date: format(expires, 'PP') }) : s('neverExpires', 'never expires') },
      ],
    },
    downloads: {
      parts: [
        f.allow_downloads
          ? { text: s('downloadsOn', 'Downloads allowed'), tone: 'strong' }
          : { text: s('downloadsOff', 'Downloads off'), tone: 'off' },
        ...(f.allow_downloads && f.watermark_downloads ? [{ text: s('watermarked', 'watermarked') }] : []),
        ...(f.allow_downloads && f.download_limit > 0 ? [{ text: s('downloadLimit', 'limit {{count}}', { count: f.download_limit }) }] : []),
      ],
    },
    guests: {
      parts: [
        f.allow_user_uploads
          ? { text: s('uploadsOn', 'Uploads on'), tone: 'strong' }
          : { text: s('uploadsOff', 'Uploads off'), tone: 'off' },
        ...(draft.feedback
          ? [draft.feedback.feedback_enabled
            ? { text: s('feedbackOn', 'feedback on') }
            : { text: s('feedbackOff', 'feedback off'), tone: 'off' as const }]
          : []),
      ],
    },
    slideshow: {
      parts: [
        event.show_share_token
          ? { text: s('linkActive', 'Link active'), tone: 'ok' }
          : { text: s('noLink', 'No link yet'), tone: 'off' },
        ...(draft.slideshow ? [{ text: s('interval', '{{seconds}} s per photo', { seconds: Math.round(draft.slideshow.interval_ms / 100) / 10 }) }] : []),
      ],
    },
    source: {
      parts: f.source_mode === 'reference'
        ? [
          { text: s('externalFolder', 'External folder'), tone: 'strong' },
          ...(f.external_watch ? [{ text: s('watching', 'watching'), tone: 'ok' as const }] : []),
        ]
        : [{ text: s('uploaded', 'Uploaded to PicPeak') }],
    },
    // Folders + two-stage delivery (issues 1786, 1562).
    delivery: {
      parts: [
        f.folder_structure
          ? { text: s('folderStructureOn', 'Folder structure on'), tone: 'ok' }
          : { text: s('folderStructureOff', 'Flat uploads'), tone: 'off' },
        ...(f.delivery_status === 'partial'
          ? [{
            text: f.delivery_due_at
              ? s('firstLookDue', 'first look, full gallery by {{date}}', { date: format(safeParseDate(f.delivery_due_at) ?? new Date(), 'PP') })
              : s('firstLook', 'first look, more to come'),
            tone: 'strong' as const,
          }]
          : []),
      ],
    },
    reminder: {
      parts: f.event_reminder_disabled
        ? [{ text: s('reminderOff', 'Off for this gallery'), tone: 'off' }]
        : [
          { text: offset === '' ? s('reminderGlobal', 'Global schedule') : s('reminderDays', '{{count}} days before', { count: Math.floor(Number(offset)) }) },
          ...(reminderDate ? [{ text: s('reminderOn', 'goes out {{date}}', { date: reminderDate }) }] : []),
        ],
      isDefault: reminderInherits,
    },
    faces: { parts: [{ text: s('faces', 'Find and group the people in the photos') }] },
    danger: { parts: [{ text: s('danger', 'Archive or delete this gallery') }] },
  };
}

export interface SettingsOverviewProps {
  sections: Array<{ key: SettingsSectionKey; label: string }>;
  /** The open section; null on a phone while the overview is shown alone. */
  active: SettingsSectionKey | null;
  onSelect: (key: SettingsSectionKey) => void;
  dirty: Set<SettingsSectionKey>;
  summaries: ReturnType<typeof useSectionSummaries>;
}

export const SettingsOverview: React.FC<SettingsOverviewProps> = ({ sections, active, onSelect, dirty, summaries }) => {
  const { t } = useTranslation();
  const byKey = new Map(sections.map((s) => [s.key, s]));

  const row = (key: SettingsSectionKey) => {
    const section = byKey.get(key);
    if (!section) return null;
    const Icon = SECTION_ICON[key];
    const danger = key === 'danger';
    const selected = key === active;
    const isDirty = dirty.has(key);
    const { parts, isDefault } = summaries[key];
    return (
      <li key={key}>
        <button
          type="button"
          data-section={key}
          onClick={() => onSelect(key)}
          aria-current={selected ? 'page' : undefined}
          className={`w-full flex items-center gap-3 px-3.5 py-2.5 2xl:px-4 2xl:py-3 rounded-xl border text-left transition-colors ${
            danger
              ? 'border-danger-line hover:bg-danger-soft'
              : selected
                // Only beside the open section; on a phone the list is shown
                // on its own, so nothing in it is "open".
                ? 'border-line bg-panel hover:bg-hover lg:border-accent lg:bg-accent-dark/10'
                : 'border-line bg-panel hover:bg-hover'
          } ${selected && danger ? 'lg:bg-danger-soft' : ''}`}
        >
          <Icon className={`w-5 h-5 shrink-0 ${danger ? 'text-danger-text' : selected ? 'text-soft lg:text-heading' : 'text-soft'}`} aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className={`flex flex-wrap items-center gap-2 text-sm font-semibold ${danger ? 'text-danger-text' : 'text-heading'}`}>
              {section.label}
              {isDefault && !isDirty && (
                <span className="px-1.5 py-px rounded-full border border-line text-[11px] font-medium text-soft">
                  {t('events.settingsTab.default', 'Default')}
                </span>
              )}
              {isDirty && (
                <span className="w-2 h-2 rounded-full bg-warning" aria-hidden="true" />
              )}
            </span>
            <span className="block mt-0.5 text-xs text-soft">
              {parts.map((p, i) => (
                <React.Fragment key={i}>
                  {i > 0 && <span className="mx-1.5 text-faint">·</span>}
                  <span className={TONE_CLASS[p.tone ?? 'plain']}>{p.text}</span>
                </React.Fragment>
              ))}
              {isDirty && (
                <>
                  <span className="mx-1.5 text-faint">·</span>
                  <span className="text-warning-text">{t('events.settingsTab.notSaved', 'not saved yet')}</span>
                </>
              )}
            </span>
          </span>
          <ChevronRight className="w-4 h-4 shrink-0 text-faint" aria-hidden="true" />
        </button>
      </li>
    );
  };

  return (
    <nav aria-label={t('events.settingsTab.sections', 'Settings sections')}>
      {/* Keeps the heading order: this h2, its group h3s, then the open section's h2.
          Outside the spaced list, so the first group starts at the top. */}
      <h2 className="sr-only">{t('events.settingsTab.sections', 'Settings sections')}</h2>
      <div className="space-y-4 2xl:space-y-6">
        {SECTION_GROUPS.map((group) => {
          const keys = group.sections.filter((k) => byKey.has(k));
          if (keys.length === 0) return null;
          return (
            <section key={group.key}>
              {/* Fixed height: the section card on the right is offset by
                  h-4 + mb-2 (1.5rem) to line up with the first row. */}
              <h3 className="h-4 px-1 mb-2 text-[11px] leading-4 font-semibold uppercase tracking-wider text-soft">
                {t(`events.settingsTab.group.${group.key}`, group.label)}
              </h3>
              <ul className="space-y-1.5 2xl:space-y-2">{keys.map(row)}</ul>
            </section>
          );
        })}
        {/* Set apart from the groups: it holds actions, not settings. */}
        {byKey.has('danger') && <ul className="!mt-8 2xl:!mt-12">{row('danger')}</ul>}
      </div>
    </nav>
  );
};
