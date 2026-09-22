/**
 * Comparing template versions (#1445): clause-level added / removed / moved
 * / changed, word-level inside a changed text.
 */
import { diffVersions, diffWords, type ComparableVersion } from '../templateDiff';

const text = (heading: string, de: string) => ({ kind: 'text' as const, blockId: null, section: 'closing' as const, heading, body: { de } });
const block = (blockId: number, name: string, body = {}, snapshot = { de: `Text ${name}` }) => ({
  kind: 'block' as const, blockId, section: 'scope' as const, heading: null, body, snapshot, name,
});
const version = (items: ComparableVersion['items'], extra: Partial<ComparableVersion> = {}): ComparableVersion => ({
  title: 'Vertrag', introText: {}, outroText: {}, items, ...extra,
});

it('word diff keeps unchanged words and marks the rest', () => {
  expect(diffWords('Die Frist beträgt 30 Tage.', 'Die Frist beträgt 14 Tage.')).toEqual([
    { type: 'same', text: 'Die Frist beträgt ' },
    { type: 'del', text: '30' },
    { type: 'add', text: '14' },
    { type: 'same', text: ' Tage.' },
  ]);
  expect(diffWords('', 'neu')).toEqual([{ type: 'add', text: 'neu' }]);
  expect(diffWords('gleich', 'gleich')).toEqual([{ type: 'same', text: 'gleich' }]);
});

it('identical versions have no changes', () => {
  const v = version([block(1, 'A'), text('Zusatz', 'x')]);
  expect(diffVersions(v, v).unchanged).toBe(true);
});

it('finds added, removed, moved and changed clauses', () => {
  const before = version([block(1, 'A'), block(2, 'B'), block(3, 'C'), text('Alt', 'weg')]);
  const after = version([block(3, 'C'), block(1, 'A', { de: 'Eigener Text' }), block(2, 'B'), text('Neu', 'da')]);
  const { clauses } = diffVersions(before, after);
  const byName = Object.fromEntries(clauses.map((c) => [c.name, c]));
  expect(byName.C).toEqual(expect.objectContaining({ type: 'moved', from: 3, to: 1 }));
  expect(byName.A).toEqual(expect.objectContaining({ type: 'changed', from: 1, to: 2 }));
  const ops = byName.A.texts[0].ops;
  expect(ops.filter((o) => o.type !== 'add').map((o) => o.text).join('')).toBe('Text A');
  expect(ops.filter((o) => o.type !== 'del').map((o) => o.text).join('')).toBe('Eigener Text');
  expect(byName.B).toBeUndefined();
  expect(byName.Neu).toEqual(expect.objectContaining({ type: 'added', to: 4 }));
  expect(byName.Alt).toEqual(expect.objectContaining({ type: 'removed', from: 4 }));
});

it('compares title, intro, outro and attachments', () => {
  const before = version([], { introText: { de: 'Hallo' }, attachments: [{ attachmentId: 1, name: 'AGB', delivery: 'merged' }] });
  const after = version([], {
    title: 'Neuer Titel', introText: { de: 'Hallo {{customer_name}}' },
    attachments: [{ attachmentId: 1, name: 'AGB', delivery: 'separate' }, { attachmentId: 2, name: 'Datenschutz', delivery: 'merged' }],
  });
  const diff = diffVersions(before, after);
  expect(diff.fields.map((f) => f.field)).toEqual(['title', 'intro']);
  expect(diff.attachments).toEqual([{ type: 'changed', name: 'AGB' }, { type: 'added', name: 'Datenschutz' }]);
});
