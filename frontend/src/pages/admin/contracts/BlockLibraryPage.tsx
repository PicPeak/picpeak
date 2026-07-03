/**
 * Admin → Contract block library.
 *
 * Two-column layout intentionally mirroring EmailConfigPage's Templates
 * tab so admins navigate one shape across all template-style editors:
 *   - Left: sticky sidebar with sections (basics / scope / privacy /
 *     commercial / nda / closing) as uppercase headings, blocks listed
 *     below each, "+ New block" button at the top. Selected block
 *     uses `tile-selected`; non-selected blocks use the same
 *     `bg-neutral-50 dark:bg-neutral-700` palette as the email tabs.
 *     Inactive blocks render `opacity-50`.
 *   - Right: edit panel with language tabs (EN/DE/RU/PT/NL/FR) at the
 *     top, then Section + Name + Description + Body fields. Active
 *     toggle + Save + Delete actions. New-block mode renders the same
 *     form with empty values and an enabled Section dropdown.
 *
 * Schema: contract_blocks carries body_text + body_text_<locale> for
 * each of the six locales (migration 130 seeded EN+DE; migration 131
 * added RU/PT/NL/FR as nullable). Translation completeness shown in
 * the sidebar pill (e.g. "3/6") matches the email-templates display.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { ArrowLeft, Plus, Trash2, Save } from 'lucide-react';
import { Button, Card, Loading } from '../../../components/common';
import { SUPPORTED_LANGUAGES } from '../../../components/common/LanguageSelector';
import {
  contractsService,
  type ContractBlock,
  type ContractBlockSection,
  CONTRACT_SECTIONS,
} from '../../../services/contracts.service';

// Locale → block column mapping. Keys mirror SUPPORTED_LANGUAGES.code;
// values are the ContractBlock field names. Used to resolve which body
// to show / save when the language tab changes.
const BODY_FIELD_BY_LOCALE: Record<string, keyof ContractBlock> = {
  en: 'bodyText',
  de: 'bodyTextDe',
  ru: 'bodyTextRu',
  pt: 'bodyTextPt',
  nl: 'bodyTextNl',
  fr: 'bodyTextFr',
};

/** Payload-key version of the same map — what the create/update API
 *  expects on POST/PUT. EN uses `bodyText`, others use `bodyText<Lang>`. */
const PAYLOAD_KEY_BY_LOCALE: Record<string, string> = {
  en: 'bodyText',
  de: 'bodyTextDe',
  ru: 'bodyTextRu',
  pt: 'bodyTextPt',
  nl: 'bodyTextNl',
  fr: 'bodyTextFr',
};

/** Selection state — either editing an existing block or composing
 *  a new one. Null = empty right panel (initial state). */
type Selection =
  | { mode: 'edit'; block: ContractBlock }
  | { mode: 'new' }
  | null;

export const BlockLibraryPage: React.FC = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [selection, setSelection] = useState<Selection>(null);
  const [editingLang, setEditingLang] = useState<string>('en');
  // The block library is the admin's authoring surface — inactive
  // blocks are always shown so admins can find blocks they previously
  // deactivated (the "Inactive" badge keeps the state obvious). The
  // toggle below now lets admins HIDE inactive blocks if they want a
  // cleaner view, but defaults to false so nothing disappears.
  const [hideInactive, setHideInactive] = useState(false);

  // Local form state mirrors the active selection. Reset whenever the
  // selection changes (via the useEffect below) so editing one block,
  // switching to another, doesn't leak unsaved changes.
  const [section, setSection] = useState<ContractBlockSection>('basics');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [bodies, setBodies] = useState<Record<string, string>>({});

  const { data, isLoading } = useQuery({
    queryKey: ['contracts', 'blocks', { hideInactive }],
    // Always fetch every block; client-side filter is purely for
    // visual hide. Keeps the cache consistent across toggle flips
    // and means the new-block flow can land in any section without
    // re-fetching.
    queryFn: () => contractsService.listBlocks({ includeInactive: true }),
  });
  const blocks = data?.blocks || [];

  // Auto-select the first block on initial load so the right panel
  // isn't empty by default — matches the email templates UX.
  useEffect(() => {
    if (selection === null && blocks.length > 0) {
      setSelection({ mode: 'edit', block: blocks[0] });
    }
  }, [blocks, selection]);

  // Sync local form state to the selection. On mode='new', clear
  // everything. On mode='edit', copy fields from the block.
  useEffect(() => {
    if (selection?.mode === 'edit') {
      const b = selection.block;
      setSection(b.section);
      setName(b.name);
      setDescription(b.description || '');
      setBodies({
        en: b.bodyText || '',
        de: b.bodyTextDe || '',
        ru: b.bodyTextRu || '',
        pt: b.bodyTextPt || '',
        nl: b.bodyTextNl || '',
        fr: b.bodyTextFr || '',
      });
    } else if (selection?.mode === 'new') {
      setSection('basics');
      setName('');
      setDescription('');
      setBodies({ en: '', de: '', ru: '', pt: '', nl: '', fr: '' });
    }
    setEditingLang('en');
  }, [selection]);

  const createMutation = useMutation({
    mutationFn: (payload: any) => contractsService.createBlock(payload),
    onSuccess: (res) => {
      toast.success(t('contracts.blocks.createdToast', 'Block created.') as string);
      queryClient.invalidateQueries({ queryKey: ['contracts', 'blocks'] });
      if (res.block) setSelection({ mode: 'edit', block: res.block });
    },
    onError: (err: any) => toast.error(err?.response?.data?.error || t('contracts.blocks.createError', 'Create failed') as string),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: any }) => contractsService.updateBlock(id, payload),
    onSuccess: (res) => {
      toast.success(t('contracts.blocks.updatedToast', 'Block updated.') as string);
      queryClient.invalidateQueries({ queryKey: ['contracts', 'blocks'] });
      if (res.block) setSelection({ mode: 'edit', block: res.block });
    },
    onError: (err: any) => toast.error(err?.response?.data?.error || t('contracts.blocks.updateError', 'Update failed') as string),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => contractsService.deleteBlock(id),
    onSuccess: () => {
      toast.success(t('contracts.blocks.deletedToast', 'Block deleted.') as string);
      queryClient.invalidateQueries({ queryKey: ['contracts', 'blocks'] });
      setSelection(null);
    },
    onError: (err: any) => toast.error(err?.response?.data?.error || t('contracts.blocks.deleteError', 'Delete failed') as string),
  });

  // Group blocks by section for sidebar rendering. Empty sections are
  // skipped so the sidebar doesn't show stub headings. Inactive blocks
  // included by default; hideInactive=true filters them out for admins
  // who want a cleaner view (the selection survives the filter — if
  // the selected block becomes hidden, the right panel still shows it
  // so the admin can re-activate without re-finding it).
  const grouped = useMemo(() => {
    const g: Record<ContractBlockSection, ContractBlock[]> = {
      basics: [], scope: [], privacy: [], commercial: [], nda: [], closing: [],
    };
    for (const b of blocks) {
      if (hideInactive && !b.isActive) continue;
      g[b.section]?.push(b);
    }
    return g;
  }, [blocks, hideInactive]);

  // Count populated bodies for the sidebar pill (e.g. "3/6" = three
  // locales have body text, three are blank). Mirrors the email
  // templates' translationCount badge.
  const translationCount = (b: ContractBlock) =>
    SUPPORTED_LANGUAGES.filter((lang) => {
      const field = BODY_FIELD_BY_LOCALE[lang.code];
      return field && !!(b[field] as string | null | undefined)?.toString().trim();
    }).length;

  const buildPayload = () => {
    const payload: Record<string, any> = {
      section,
      name: name.trim(),
      description: description.trim() || null,
      isActive: selection?.mode === 'edit' ? selection.block.isActive : true,
    };
    for (const lang of SUPPORTED_LANGUAGES) {
      const key = PAYLOAD_KEY_BY_LOCALE[lang.code];
      const val = (bodies[lang.code] || '').trim();
      // EN is required; other locales are sent only when non-empty
      // so clearing a textarea reliably nulls the column.
      if (lang.code === 'en') {
        payload[key] = bodies.en;
      } else {
        payload[key] = val ? bodies[lang.code] : null;
      }
    }
    return payload;
  };

  const canSave = !!name.trim() && !!(bodies.en || '').trim();
  const isPending = createMutation.isPending || updateMutation.isPending;

  const handleSave = () => {
    if (!canSave) return;
    const payload = buildPayload();
    if (selection?.mode === 'edit') {
      updateMutation.mutate({ id: selection.block.id, payload });
    } else if (selection?.mode === 'new') {
      createMutation.mutate(payload);
    }
  };

  const handleToggleActive = () => {
    if (selection?.mode !== 'edit') return;
    updateMutation.mutate({
      id: selection.block.id,
      payload: { isActive: !selection.block.isActive },
    });
  };

  const currentBody = bodies[editingLang] || '';
  const setCurrentBody = (v: string) => setBodies((prev) => ({ ...prev, [editingLang]: v }));

  return (
    // No `container py-6` wrapper — this page is rendered inside the
    // System Settings shell, which already provides outer padding +
    // its own width. The email-templates tab next door uses the same
    // bare layout; adding our own container made the contracts grid
    // measurably narrower than the email grid.
    <div>
      <div className="mb-4 flex items-center gap-3 flex-wrap">
        <Link
          to="/admin/clients/contracts"
          className="inline-flex items-center gap-1 text-sm text-neutral-600 dark:text-neutral-400 hover:text-accent-dark"
        >
          <ArrowLeft className="w-4 h-4" />
          {t('contracts.blocks.back', 'Back to contracts')}
        </Link>
        <h1 className="text-2xl font-bold flex-1 text-neutral-900 dark:text-neutral-100">
          {t('contracts.blocks.title', 'Contract block library')}
        </h1>
        <label className="flex items-center gap-2 text-sm text-neutral-500 dark:text-neutral-400">
          <input type="checkbox" checked={hideInactive} onChange={(e) => setHideInactive(e.target.checked)} />
          {t('contracts.blocks.hideInactive', 'Hide inactive')}
        </label>
      </div>

      {/* Disclaimer banner — kept; the seeded blocks come with a legal
          disclaimer per the maintainer's "legal/financial defaults are
          examples only" rule. */}
      <div className="mb-4 p-3 rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 text-sm text-amber-900 dark:text-amber-200">
        <p className="font-medium mb-1">
          {t('contracts.blocks.disclaimerTitle', 'Examples only — have your lawyer review')}
        </p>
        <p className="text-xs">
          {t(
            'contracts.blocks.disclaimerBody',
            'The seeded "System" blocks are written by the picpeak maintainer, not by a lawyer. They are intended as starting points only — review and adapt every block you intend to send with your own lawyer. Edits to system blocks are persisted; replace the seeded body text with the lawyer-reviewed version in place.',
          )}
        </p>
      </div>

      {isLoading ? <Loading /> : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Sidebar — same shape as EmailConfigPage templates sidebar:
              Card padding="sm" + h3 + +New button up top, then a
              section-grouped list of block tiles. */}
          <Card padding="sm">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
                {t('contracts.blocks.sidebarHeading', 'Blocks')}
              </h3>
              <Button
                variant="primary"
                size="sm"
                onClick={() => setSelection({ mode: 'new' })}
                leftIcon={<Plus className="w-4 h-4" />}
              >
                {t('contracts.blocks.new', 'New block')}
              </Button>
            </div>
            <div className="space-y-5">
              {CONTRACT_SECTIONS.map((sec) => {
                const items = grouped[sec];
                if (!items || items.length === 0) return null;
                return (
                  <div key={sec}>
                    <h4 className="px-1 mb-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                      {t(`contracts.sections.${sec}`, sec)}
                    </h4>
                    <div className="space-y-2">
                      {items.map((b) => {
                        const isSelected = selection?.mode === 'edit' && selection.block.id === b.id;
                        const count = translationCount(b);
                        return (
                          <button
                            key={b.id}
                            onClick={() => setSelection({ mode: 'edit', block: b })}
                            className={`w-full text-left p-3 rounded-lg transition-colors ${
                              isSelected
                                ? 'tile-selected'
                                : 'bg-neutral-50 dark:bg-neutral-700 border-2 border-transparent hover:bg-neutral-100 dark:hover:bg-neutral-600'
                            } ${!b.isActive ? 'opacity-50' : ''}`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <p className="font-medium text-neutral-900 dark:text-neutral-100 truncate">
                                {b.name}
                              </p>
                              <div className="flex items-center gap-1.5 flex-shrink-0">
                                {b.isSystem && (
                                  <span
                                    className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-semibold bg-neutral-200 dark:bg-neutral-600 text-neutral-700 dark:text-neutral-300"
                                    title={t('contracts.blocks.systemBadge', 'System') as string}
                                  >
                                    {t('contracts.blocks.systemBadge', 'System')}
                                  </span>
                                )}
                                <span className="text-xs px-2 py-0.5 rounded-full bg-neutral-200 dark:bg-neutral-600 text-neutral-600 dark:text-neutral-300">
                                  {count}/{SUPPORTED_LANGUAGES.length}
                                </span>
                              </div>
                            </div>
                            {b.description && (
                              <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1 truncate">
                                {b.description}
                              </p>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
              {blocks.length === 0 && (
                <p className="text-center text-sm text-neutral-500 dark:text-neutral-400 py-6">
                  {t('contracts.blocks.empty', 'No blocks yet.')}
                </p>
              )}
            </div>
          </Card>

          {/* Right panel — edit / create form. lg:col-span-2 matches the
              email-templates layout exactly. */}
          <div className="lg:col-span-2">
            {selection === null ? (
              <Card padding="md">
                <p className="text-center text-neutral-500 dark:text-neutral-400 py-8">
                  {t('contracts.blocks.selectPrompt', 'Select a block on the left or create a new one to start editing.')}
                </p>
              </Card>
            ) : (
              <Card padding="md">
                <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
                  <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
                    {selection.mode === 'new'
                      ? t('contracts.blocks.dialog.createTitle', 'New block')
                      : t('contracts.blocks.dialog.editTitle', 'Edit block')}
                  </h3>
                  <div className="flex gap-2 items-center flex-wrap">
                    {selection.mode === 'edit' && (
                      <label className="flex items-center gap-2 text-sm text-neutral-500 dark:text-neutral-400 mr-2">
                        <input
                          type="checkbox"
                          checked={selection.block.isActive}
                          onChange={handleToggleActive}
                        />
                        {selection.block.isActive
                          ? t('contracts.blocks.active', 'Active')
                          : t('contracts.blocks.inactive', 'Inactive')}
                      </label>
                    )}
                    {selection.mode === 'edit' && !selection.block.isSystem && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          if (window.confirm(t('contracts.blocks.deleteConfirm', 'Delete this block?') as string)) {
                            deleteMutation.mutate(selection.block.id);
                          }
                        }}
                        leftIcon={<Trash2 className="w-4 h-4" />}
                      >
                        {t('contracts.blocks.delete', 'Delete')}
                      </Button>
                    )}
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={handleSave}
                      isLoading={isPending}
                      disabled={!canSave}
                      leftIcon={<Save className="w-4 h-4" />}
                    >
                      {t('contracts.blocks.save', 'Save')}
                    </Button>
                  </div>
                </div>

                {/* Language tabs — identical pill row to EmailConfigPage. */}
                <div className="flex flex-wrap gap-1 mb-4 p-1 bg-neutral-100 dark:bg-neutral-700 rounded-lg">
                  {SUPPORTED_LANGUAGES.map((lang) => {
                    const filled = !!(bodies[lang.code] || '').trim();
                    return (
                      <button
                        key={lang.code}
                        onClick={() => setEditingLang(lang.code)}
                        className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors flex items-center gap-1.5 ${
                          editingLang === lang.code
                            ? 'bg-white dark:bg-neutral-800 text-accent-dark shadow-sm'
                            : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200'
                        }`}
                      >
                        <lang.Flag />
                        <span>{lang.name}</span>
                        {!filled && lang.code !== 'en' && (
                          <span
                            className="w-1.5 h-1.5 rounded-full bg-amber-400"
                            title={t('contracts.blocks.noTranslation', 'No translation yet') as string}
                          />
                        )}
                      </button>
                    );
                  })}
                </div>

                <div className="space-y-4">
                  {/* Name above Section, stacked vertically — Name is
                      the primary identifier and reads best at full
                      width; Section is a one-of-six dropdown that
                      doesn't need to share row space. Section stays
                      locked when editing a system block. */}
                  <div>
                    <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                      {t('contracts.blocks.dialog.name', 'Name')}
                    </label>
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                      {t('contracts.blocks.dialog.section', 'Section')}
                    </label>
                    <select
                      value={section}
                      onChange={(e) => setSection(e.target.value as ContractBlockSection)}
                      disabled={selection.mode === 'edit' && selection.block.isSystem}
                      className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm disabled:opacity-50"
                    >
                      {CONTRACT_SECTIONS.map((s) => (
                        <option key={s} value={s}>{t(`contracts.sections.${s}`, s)}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                      {t('contracts.blocks.dialog.description', 'Description (admin hint)')}
                    </label>
                    <input
                      type="text"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                      {t('contracts.blocks.dialog.body', 'Body')} ({SUPPORTED_LANGUAGES.find((l) => l.code === editingLang)?.name || editingLang})
                    </label>
                    <textarea
                      rows={14}
                      value={currentBody}
                      onChange={(e) => setCurrentBody(e.target.value)}
                      className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm font-mono"
                    />
                  </div>

                  {/* Special-block preview: quote_line_items_table
                      generates an actual PDF table from the source
                      quote's line items at render time. The block's
                      body text is just the intro paragraph above the
                      table; without this callout the admin had no way
                      to know the table existed (it appears in the PDF
                      but nowhere in the block editor). */}
                  {selection.mode === 'edit' && selection.block.slug === 'quote_line_items_table' && (
                    <div className="rounded-md border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30 p-3 text-sm text-blue-900 dark:text-blue-200">
                      <p className="font-medium mb-1">
                        {t('contracts.blocks.quoteLineItems.calloutTitle',
                          'Auto-generated table follows the body')}
                      </p>
                      <p className="text-xs">
                        {t('contracts.blocks.quoteLineItems.calloutBody',
                          'When this block is included in a contract that was created from a quote, the PDF inserts a real table of the source quote\'s line items (#, Description, Qty, Unit, Total) immediately after the body text above. Sub-items render indented with a ↳ marker. Contracts without a source quote skip the table and render only the body.')}
                      </p>
                      <p className="text-xs mt-2 opacity-80">
                        {t('contracts.blocks.quoteLineItems.previewExample',
                          'Example rendered output:')}
                      </p>
                      <pre className="mt-1 text-[11px] font-mono bg-white/50 dark:bg-neutral-900/40 rounded p-2 overflow-x-auto">
{`#   Description                      Qty    Unit       Total
1   Photography session              1      CHF 800    CHF 800
2   Photo prints                     2      CHF 15     CHF 30
       ↳ Extra retouching            1      CHF 20     CHF 20`}
                      </pre>
                    </div>
                  )}

                  <p className="text-xs text-neutral-500 dark:text-neutral-400">
                    {t(
                      'contracts.blocks.dialog.placeholderHint',
                      'You can use {{customer_name}}, {{event_name}}, {{event_date}}, {{net_days}}, {{skonto_percent}}, {{skonto_within_days}}, {{cancellation_30d_percent}}, {{currency}}, {{issuer_company_name}}, {{issuer_address}}, {{contract_number}}, {{source_quote_number}} as placeholders — substituted when the contract is rendered.',
                    )}
                  </p>
                </div>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
