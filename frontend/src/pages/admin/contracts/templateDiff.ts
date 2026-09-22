/**
 * What changed between two versions of a contract template (#1445): clause
 * by clause — added, removed, moved, changed — and word by word inside a
 * changed text. Hand-written LCS rather than a diff dependency; texts are
 * clause-sized, and a pair too large for the table is shown as replaced.
 */
import type { ContractLocale, ContractTemplateItem, LocaleText } from '../../../services/contractTemplates.service';

export type WordOp = { type: 'same' | 'add' | 'del'; text: string };

/** Beyond this many table cells a text pair is shown as replaced whole. */
const MAX_CELLS = 2_000_000;
/**
 * Table cells for a whole comparison, across all its text pairs. Past it,
 * the remaining changed texts say "too large to compare here" instead of
 * freezing the page on a template with many long clauses.
 */
const TOTAL_CELLS = 8_000_000;

/** What a comparison may still spend on word diffs. */
export interface DiffBudget { cells: number }

/** Longest common subsequence of `a` and `b` as index pairs, in order. */
function lcs<T>(a: T[], b: T[], equal: (x: T, y: T) => boolean): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = equal(a[i], b[j]) ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (equal(a[i], b[j])) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) i += 1;
    else j += 1;
  }
  return pairs;
}

/** Word-level diff of two texts; whitespace is kept with the words. */
export function diffWords(before: string, after: string): WordOp[] {
  if (before === after) return before ? [{ type: 'same', text: before }] : [];
  const a = before.split(/(\s+)/).filter(Boolean);
  const b = after.split(/(\s+)/).filter(Boolean);
  if ((a.length + 1) * (b.length + 1) > MAX_CELLS) {
    return [...(before ? [{ type: 'del' as const, text: before }] : []), ...(after ? [{ type: 'add' as const, text: after }] : [])];
  }
  const ops: WordOp[] = [];
  const push = (type: WordOp['type'], text: string) => {
    const last = ops[ops.length - 1];
    if (last && last.type === type) last.text += text;
    else ops.push({ type, text });
  };
  let i = 0;
  let j = 0;
  for (const [pi, pj] of lcs(a, b, (x, y) => x === y)) {
    while (i < pi) push('del', a[i++]);
    while (j < pj) push('add', b[j++]);
    push('same', a[i]);
    i += 1;
    j += 1;
  }
  while (i < a.length) push('del', a[i++]);
  while (j < b.length) push('add', b[j++]);
  return ops;
}

/** The parts of a version the comparison reads (a draft in the editor has the same shape). */
export interface ComparableVersion {
  /**
   * The template's own name, description and use case — only an editor draft
   * has them (a saved version doesn't); compared when both sides do.
   */
  meta?: { name: string; description: string; useCase: string };
  title: string;
  introText: LocaleText;
  outroText: LocaleText;
  items: Array<Pick<ContractTemplateItem, 'kind' | 'blockId' | 'section' | 'heading' | 'body' | 'snapshot'> & {
    block?: ContractTemplateItem['block'];
    name?: string | null;
  }>;
  attachments?: Array<{ attachmentId: number; name: string; delivery: string }>;
}

export interface TextChange {
  locale: ContractLocale;
  ops: WordOp[];
  /** The comparison's budget ran out: no word diff for this text. */
  tooLarge?: boolean;
}

export interface ClauseChange {
  type: 'added' | 'removed' | 'moved' | 'changed';
  name: string;
  /** 1-based positions before and after. */
  from: number | null;
  to: number | null;
  texts: TextChange[];
  /** Moved and also edited. */
  moved?: boolean;
}

export interface VersionDiff {
  fields: Array<{ field: 'name' | 'description' | 'useCase' | 'title' | 'intro' | 'outro'; texts: TextChange[] }>;
  clauses: ClauseChange[];
  attachments: Array<{ type: 'added' | 'removed' | 'moved' | 'changed'; name: string }>;
  unchanged: boolean;
}

type Item = ComparableVersion['items'][number];

/** What a clause says in each language: a block's own text over its frozen (or library) text. */
function effectiveText(item: Item): LocaleText {
  if (item.kind !== 'block') return item.body || {};
  const base = item.snapshot && Object.keys(item.snapshot).length ? item.snapshot : (item.block?.bodies || {});
  return { ...base, ...Object.fromEntries(Object.entries(item.body || {}).filter(([, v]) => typeof v === 'string' && v !== '')) };
}

const clauseName = (item: Item) => (item.kind === 'block' ? (item.name || item.block?.name || '') : (item.heading || '')) || '';

/** Identity across versions: the library block, or the free text's heading. */
const identity = (item: Item) => (item.kind === 'block' ? `block:${item.blockId}` : `text:${(item.heading || '').trim().toLowerCase()}`);

function textChanges(before: LocaleText, after: LocaleText, budget: DiffBudget): TextChange[] {
  const locales = [...new Set([...Object.keys(before), ...Object.keys(after)])] as ContractLocale[];
  return locales
    .filter((l) => (before[l] || '') !== (after[l] || ''))
    .map((locale) => {
      const a = before[locale] || '';
      const b = after[locale] || '';
      const cells = (a.split(/(\s+)/).length + 1) * (b.split(/(\s+)/).length + 1);
      if (cells > budget.cells) return { locale, ops: [], tooLarge: true };
      budget.cells -= cells;
      return { locale, ops: diffWords(a, b) };
    });
}

export function diffVersions(before: ComparableVersion, after: ComparableVersion, budget: DiffBudget = { cells: TOTAL_CELLS }): VersionDiff {
  const changes = (x: LocaleText, y: LocaleText) => textChanges(x, y, budget);
  const fields: VersionDiff['fields'] = [];
  if (before.meta && after.meta) {
    for (const field of ['name', 'description', 'useCase'] as const) {
      const texts = changes({ de: before.meta[field] || '' }, { de: after.meta[field] || '' });
      if (texts.length) fields.push({ field, texts });
    }
  }
  const title = changes({ de: before.title || '' }, { de: after.title || '' });
  if (title.length) fields.push({ field: 'title', texts: title });
  const intro = changes(before.introText || {}, after.introText || {});
  if (intro.length) fields.push({ field: 'intro', texts: intro });
  const outro = changes(before.outroText || {}, after.outroText || {});
  if (outro.length) fields.push({ field: 'outro', texts: outro });

  // Pair clauses by identity (the n-th occurrence with the n-th), then take
  // the longest run that kept its order: whatever is paired but outside it moved.
  const occurrence = (items: Item[]) => {
    const seen = new Map<string, number>();
    return items.map((item) => {
      const id = identity(item);
      const n = seen.get(id) || 0;
      seen.set(id, n + 1);
      return `${id}#${n}`;
    });
  };
  const oldIds = occurrence(before.items);
  const newIds = occurrence(after.items);
  const oldIndex = new Map(oldIds.map((id, i) => [id, i]));
  const paired = newIds.map((id) => (oldIndex.has(id) ? oldIndex.get(id)! : -1));
  const pairedList = paired.map((o, n) => [o, n] as const).filter(([o]) => o >= 0);
  // The pairs that kept their relative order: the longest common subsequence
  // of their old positions (in new order) with those positions sorted.
  const olds = pairedList.map(([o]) => o);
  const inOrder = new Set(lcs(olds, [...olds].sort((x, y) => x - y), (x, y) => x === y).map(([k]) => k));

  const clauses: ClauseChange[] = [];
  const matchedOld = new Set<number>();
  pairedList.forEach(([o, n], k) => {
    matchedOld.add(o);
    const texts = changes(effectiveText(before.items[o]), effectiveText(after.items[n]));
    const moved = !inOrder.has(k);
    if (!moved && !texts.length && before.items[o].section === after.items[n].section) return;
    clauses.push({
      type: texts.length ? 'changed' : 'moved',
      name: clauseName(after.items[n]),
      from: o + 1,
      to: n + 1,
      texts,
      ...(texts.length && moved ? { moved: true } : {}),
    });
  });
  paired.forEach((o, n) => {
    if (o >= 0) return;
    clauses.push({ type: 'added', name: clauseName(after.items[n]), from: null, to: n + 1, texts: changes({}, effectiveText(after.items[n])) });
  });
  before.items.forEach((item, o) => {
    if (matchedOld.has(o)) return;
    clauses.push({ type: 'removed', name: clauseName(item), from: o + 1, to: null, texts: changes(effectiveText(item), {}) });
  });
  clauses.sort((x, y) => (x.to ?? x.from ?? 0) - (y.to ?? y.from ?? 0));

  const attachments: VersionDiff['attachments'] = [];
  const beforeAtt = new Map((before.attachments || []).map((a) => [a.attachmentId, a]));
  const afterAtt = new Map((after.attachments || []).map((a) => [a.attachmentId, a]));
  for (const [id, a] of afterAtt) {
    const old = beforeAtt.get(id);
    if (!old) attachments.push({ type: 'added', name: a.name });
    else if (old.delivery !== a.delivery) attachments.push({ type: 'changed', name: a.name });
  }
  for (const [id, a] of beforeAtt) if (!afterAtt.has(id)) attachments.push({ type: 'removed', name: a.name });
  // Order is part of a version (it is the merged PDF's page order): of the
  // attachments on both sides, those outside the longest run that kept its
  // order moved.
  const keptBefore = (before.attachments || []).filter((a) => afterAtt.has(a.attachmentId)).map((a) => a.attachmentId);
  const keptAfter = (after.attachments || []).filter((a) => beforeAtt.has(a.attachmentId));
  const stayed = new Set(lcs(keptAfter.map((a) => a.attachmentId), keptBefore, (x, y) => x === y).map(([k]) => k));
  keptAfter.forEach((a, k) => {
    if (!stayed.has(k)) attachments.push({ type: 'moved', name: a.name });
  });

  return { fields, clauses, attachments, unchanged: !fields.length && !clauses.length && !attachments.length };
}
