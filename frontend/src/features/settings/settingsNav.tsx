import { useTranslation } from 'react-i18next';
import {
  ToggleRight,
  Sliders,
  CalendarPlus,
  Activity,
  Lock,
  Shield,
  Image as ImageIcon,
  Search,
  Tags,
  Download as DownloadIcon,
  Tag,
  BarChart3,
  Flag,
  Code,
  KeyRound,
  Webhook,
  Mail,
  Palette,
  FileText,
  HardDrive,
  Briefcase,
  Receipt,
  ScrollText,
  Landmark,
  Smartphone,
  MonitorPlay,
  Send as SendIcon,
  Users,
  HeartPulse,
  type LucideIcon,
} from 'lucide-react';
import { useFeatureFlags } from '../../contexts/FeatureFlagsContext';
import { usePermissions } from '../../contexts/PermissionsContext';

// Single source of truth for the Settings navigation. The admin sidebar
// renders these groups in place of the main menu while the admin is on
// /admin/settings, and SettingsPage uses the same declaration for the
// section heading, deep-link validation and the snap-back rules — so
// the two can never drift apart.

// Tab keys driving the Settings navigation. Must include every key used
// in `useSettingsNavGroups` below and in the switch at the bottom of
// SettingsPage.
export type SettingsTab =
  | 'usage'
  | 'features'
  | 'general'
  | 'events'
  | 'eventTypes'
  | 'branding'
  | 'categories'
  | 'thumbnails'
  | 'downloads'
  | 'styling'
  | 'cms'
  | 'email'
  | 'moderation'
  // PicTransfer upload policy (#1544) — which file types a client may send,
  // and the accept-all escape hatch.
  | 'transfers'
  | 'security'
  | 'sso'
  | 'imageSecurity'
  | 'seo'
  | 'apiTokens'
  | 'webhooks'
  | 'status'
  | 'analytics'
  | 'backup'
  // CRM (#TBD): issuer block for quote/invoice PDFs and per-area
  // CRM behaviour toggles.
  | 'businessProfile'
  | 'crm'
  | 'contracts'
  | 'accounting'
  | 'whatsapp'
  | 'slideshow'
  // People & access — user management moved out of the top-level sidebar.
  | 'users'
  // System health moved out of the top-level sidebar. Sits next to
  // `status`: status is "what is running", health is "what is stuck".
  | 'health';

export interface SettingsNavItem {
  key: SettingsTab;
  label: string;
  icon: LucideIcon;
  /** One line under the page title, for tabs whose scope needs saying. */
  description?: string;
  /**
   * Extra search terms for this tab, so the Settings filter and the command
   * palette find it by what it *does* rather than only by its title —
   * "SMTP" has to reach Email, "GDPR" has to reach Privacy. Attached by
   * `useSettingsNavGroups`; see `tabKeywords`.
   */
  keywords?: string[];
}

export interface SettingsNavGroup {
  label: string;
  items: SettingsNavItem[];
}

export const ALL_SETTINGS_TABS: SettingsTab[] = [
  'usage',
  'features', 'general', 'events', 'eventTypes',
  'users',
  'branding', 'categories', 'thumbnails', 'downloads', 'styling', 'cms',
  'email', 'moderation', 'transfers',
  'security', 'sso', 'imageSecurity', 'seo',
  'apiTokens', 'webhooks',
  'status', 'health', 'analytics', 'backup',
  'businessProfile', 'crm', 'contracts', 'accounting', 'whatsapp',
  'slideshow',
];

export const DEFAULT_SETTINGS_TAB: SettingsTab = 'features';

export function isValidSettingsTab(value: string | null): value is SettingsTab {
  return value !== null && (ALL_SETTINGS_TABS as string[]).includes(value);
}

export const SETTINGS_PATH = '/admin/settings';

export function settingsTabHref(tab: SettingsTab): string {
  return `${SETTINGS_PATH}?tab=${tab}`;
}

// Per-tab permission gating (multi-photographer permission project). Each tab is
// shown when the user holds ANY of the listed permissions. `settings.view` is in
// every set as the baseline "can read settings" grant, so admin/super_admin (who
// hold it) keep seeing every tab — no regression. A specialised role WITHOUT
// settings.view (e.g. a bookkeeper granted only settings.banking) reaches
// Settings via the broadened sidebar gate and sees only the tabs whose specific
// permission it holds. Backend routes enforce the same perms regardless of UI.
export const SETTINGS_TAB_PERMISSIONS: Record<SettingsTab, string[]> = {
  usage:            ['settings.edit'],
  features:          ['settings.view', 'settings.features'],
  general:           ['settings.view', 'settings.domains'],
  events:            ['settings.view'],
  eventTypes:        ['settings.view', 'event_types.view', 'event_types.manage'],
  branding:          ['settings.view', 'branding.view', 'branding.edit'],
  categories:        ['settings.view'],
  thumbnails:        ['settings.view'],
  downloads:         ['settings.view'],
  styling:           ['settings.view', 'branding.edit'],
  cms:               ['settings.view', 'cms.view', 'cms.edit'],
  email:             ['settings.view', 'email.view', 'email.edit'],
  moderation:        ['settings.view'],
  security:          ['settings.view', 'settings.security'],
  sso:               ['settings.view', 'settings.security'],
  imageSecurity:     ['settings.view', 'image_security.view', 'image_security.manage'],
  seo:               ['settings.view'],
  apiTokens:         ['settings.view', 'settings.integrations'],
  webhooks:          ['settings.view', 'settings.integrations'],
  status:            ['settings.view', 'system.view', 'system.manage'],
  analytics:         ['settings.view', 'analytics.view'],
  backup:            ['settings.view', 'backup.view'],
  businessProfile:   ['settings.view', 'settings.banking'],
  crm:               ['settings.view'],
  contracts:         ['settings.view', 'contracts.view', 'contracts.manage'],
  accounting:        ['settings.view', 'settings.banking', 'accounting.view', 'accounting.manage'],
  whatsapp:          ['settings.view', 'whatsapp.view', 'whatsapp.manage'],
  slideshow:         ['settings.view'],
  transfers:         ['settings.view'],
  // Deliberately NOT carrying the `settings.view` baseline: every other tab
  // lists it as "can read settings at all", but user management was gated on
  // `users.view` alone while it was a top-level entry. Adding the baseline
  // here would hand the tab to every role holding `settings.view` — a
  // widening of access disguised as a navigation change.
  users:             ['users.view'],
  health:            ['settings.view', 'system.view'],
};

// The union of every settings-tab permission — used to decide whether to show
// the Settings entry in the sidebar for a specialised role that lacks the
// general settings.view read but holds one specific config permission.
export const SETTINGS_TAB_PERMISSIONS_ANY: string[] = Array.from(
  new Set(Object.values(SETTINGS_TAB_PERMISSIONS).flat())
);

/**
 * Lowercase, strip diacritics and collapse whitespace so a search for
 * "impressum" matches "Impressum" and "buro" matches "Büro". Exported
 * because the command palette indexes more than Settings and has to score
 * every source the same way.
 */
export function normalizeSearch(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Does this entry match the query? A label prefix beats a label substring,
 * which beats a keyword hit; 0 means no match. Callers sort descending so
 * typing "se" offers "SEO" before "Image protection".
 */
export function searchScore(query: string, label: string, keywords: string[] = []): number {
  const q = normalizeSearch(query);
  if (!q) return 1;
  const l = normalizeSearch(label);
  if (l.startsWith(q)) return 3;
  if (l.includes(q)) return 2;
  if (keywords.some((k) => normalizeSearch(k).includes(q))) return 1;
  return 0;
}

type Flags = ReturnType<typeof useFeatureFlags>['flags'];

// Tabs that configure a feature behind a master flag hide when that flag
// is off, so admins don't navigate to a tab for a feature they can't use.
export function settingsTabGatedOff(flags: Flags): Partial<Record<SettingsTab, boolean>> {
  return {
    crm: !(flags.quotes || flags.bills || flags.contracts || flags.documents),
    contracts: !flags.contracts,
    accounting: !flags.accounting,
    whatsapp: !flags.whatsapp,
    slideshow: !flags.slideshow,
    transfers: !flags.transfers,
    users: !flags.userManagement,
  };
}

/**
 * The grouped Settings navigation, already filtered down to what the
 * current admin may see (feature flags + per-tab permissions). Groups
 * left empty are dropped.
 */
export function useSettingsNavGroups(): SettingsNavGroup[] {
  const { t } = useTranslation();
  const { flags } = useFeatureFlags();
  const { hasAnyPermission } = usePermissions();

  const groups: SettingsNavGroup[] = [
    {
      label: t('settings.groups.general', 'General'),
      items: [
        { key: 'features',   label: t('settings.features.title',   'Features'),       icon: ToggleRight },
        { key: 'general',    label: t('settings.general.title'),                       icon: Sliders },
        { key: 'events',     label: t('settings.events.title',     'Event Creation'),  icon: CalendarPlus },
        { key: 'eventTypes', label: t('settings.eventTypes.title', 'Event Types'),     icon: Tag },
      ],
    },
    {
      // People & access — Users was a top-level sidebar entry until the
      // navigation cleanup. It is configuration, not a workspace, so it
      // belongs here; the entry hides entirely when `userManagement` is off,
      // exactly as the sidebar entry did.
      label: t('settings.groups.people', 'People & access'),
      items: [
        ...(flags.userManagement
          ? [{ key: 'users' as const, label: t('navigation.users', 'Users'), icon: Users }]
          : []),
      ],
    },
    {
      label: t('settings.groups.appearance', 'Content & Appearance'),
      items: [
        { key: 'branding',   label: t('settings.branding.title',   'Branding'),    icon: Palette },
        { key: 'categories', label: t('settings.categories.title'),                 icon: Tags },
        { key: 'thumbnails', label: t('settings.thumbnails.title', 'Thumbnails'),  icon: ImageIcon },
        { key: 'downloads',  label: t('settings.downloads.title',  'Download resolutions'), icon: DownloadIcon },
        { key: 'styling',    label: t('settings.styling.title',    'Custom CSS'),  icon: Code },
        { key: 'cms',        label: t('settings.cms.title',        'CMS Pages'),   icon: FileText },
        ...(flags.slideshow
          ? [{ key: 'slideshow' as const, label: t('settings.slideshow.title', 'Slideshow'), icon: MonitorPlay }]
          : []),
      ],
    },
    {
      label: t('settings.groups.communication', 'Communication'),
      items: [
        { key: 'email',      label: t('settings.email.title',      'Email Settings'), icon: Mail },
        { key: 'moderation', label: t('settings.moderation.title', 'Moderation'),     icon: Flag },
        ...(flags.transfers
          ? [{
            key: 'transfers' as const,
            label: t('settings.transfers.title', 'PicTransfer'),
            icon: SendIcon,
            description: t('settings.transfers.description', 'Which file types clients may send you, and how large.'),
          }]
          : []),
      ],
    },
    {
      label: t('settings.groups.privacySecurity', 'Privacy & Security'),
      items: [
        { key: 'security',      label: t('settings.security.title'),                       icon: Lock },
        { key: 'sso',           label: t('settings.sso.title',           'Single Sign-On'),   icon: KeyRound },
        { key: 'imageSecurity', label: t('settings.imageSecurity.title', 'Image Protection'), icon: Shield },
        { key: 'seo',           label: t('settings.seo.title',           'SEO & Robots'),     icon: Search },
      ],
    },
    {
      label: t('settings.groups.integrations', 'Integrations'),
      items: [
        { key: 'apiTokens', label: t('settings.apiTokens.title', 'API Tokens'), icon: KeyRound },
        { key: 'webhooks',  label: t('settings.webhooks.title',  'Webhooks'),   icon: Webhook },
      ],
    },
    {
      // CRM group. businessProfile is always relevant (the issuer block
      // feeds every PDF, gallery hero, footer, etc — even with zero
      // CRM features). The remaining items hide when their matching
      // master flag is off.
      label: t('settings.groups.crm', 'CRM-Settings'),
      items: [
        { key: 'businessProfile', label: t('settings.businessProfile.title', 'Business profile'), icon: Briefcase },
        ...(flags.quotes || flags.bills || flags.contracts || flags.documents
          ? [{ key: 'crm' as const,               label: t('settings.crm.title',               'CRM behaviour'),   icon: Receipt }]
          : []),
        ...(flags.contracts
          ? [{ key: 'contracts' as const,         label: t('settings.contracts.title',         'Contracts'),       icon: ScrollText }]
          : []),
        ...(flags.accounting
          ? [{ key: 'accounting' as const,        label: t('settings.accounting.title',        'Accounting'),      icon: Landmark }]
          : []),
        ...(flags.whatsapp
          ? [{ key: 'whatsapp' as const,          label: t('settings.whatsapp.title',          'WhatsApp'),        icon: Smartphone }]
          : []),
      ],
    },
    {
      label: t('settings.groups.system', 'System'),
      items: [
        // Status and Health sat in this group under two names for the same
        // idea ("System Status" and "System health"), one of them a top-level
        // sidebar entry. They answer different questions, so they keep both
        // tabs and say which is which.
        {
          key: 'status', label: t('settings.systemStatus.title'), icon: Activity,
          description: t('settings.systemStatus.description', 'Services, queues, storage and version — what this instance is running right now.'),
        },
        {
          key: 'health', label: t('settings.health.title', 'Health'), icon: HeartPulse,
          description: t('settings.health.description', 'Background failures that need attention — stuck emails, failed checks and cleanup.'),
        },
        { key: 'analytics', label: t('settings.analytics.title'),              icon: BarChart3 },
        { key: 'usage',     label: t('productUsage.title'),                    icon: Shield },
        { key: 'backup',    label: t('settings.backup.title', 'Backup'),       icon: HardDrive },
      ],
    },
  ];

  return groups
    .map((g) => ({
      ...g,
      items: g.items
        .filter((i) => hasAnyPermission(SETTINGS_TAB_PERMISSIONS[i.key] ?? ['settings.view']))
        // Search terms are attached here rather than written into every item
        // literal above: they are search-only metadata, and threading them
        // through 30 declarations would bury the navigation in them.
        .map((i) => ({ ...i, keywords: tabKeywords(t, i.key) })),
    }))
    .filter((g) => g.items.length > 0);
}

/**
 * Search terms for a tab, so the Settings filter and the command palette find
 * it by what it *does* — "SMTP" has to reach Email, "Impressum" the CMS pages.
 *
 * They live in the locale bundles like every other string, rather than half in
 * a TypeScript map: en and de are authored, and the six deliberately-partial
 * locales inherit the English terms through i18next's `fallbackLng`. That is
 * the right answer anyway — SMTP, DNS, SSO, CSS and IBAN are what admins type
 * whatever language they read the labels in.
 */
function tabKeywords(t: ReturnType<typeof useTranslation>['t'], key: SettingsTab): string[] {
  const raw = t(`settings.keywords.${key}`, { returnObjects: true, defaultValue: [] }) as unknown;
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Whether this role can see any Settings tab at all. The sidebar entry and
 * the header's Settings item follow this rather than `settings.view`: the
 * tabs accept narrower permissions (branding.view, cms.edit, …), so a role
 * with one of those needs the way in, and a role with none must not land
 * on a Settings page with nothing to show.
 */
export function useHasVisibleSettings(): boolean {
  return useSettingsNavGroups().length > 0;
}
