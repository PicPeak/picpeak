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

it('past its total budget a comparison marks the remaining texts too large instead of diffing them', () => {
  const long = (w: string) => Array.from({ length: 400 }, (_, i) => `${w}${i}`).join(' ');
  const before = version([text('A', long('a')), text('B', long('b'))]);
  const after = version([text('A', long('x')), text('B', long('y'))]);
  const { clauses } = diffVersions(before, after, { cells: 700_000 });
  expect(clauses[0].texts[0].tooLarge).toBeUndefined();
  expect(clauses[1].texts[0]).toEqual({ locale: 'de', ops: [], tooLarge: true });
});

it('reports attachments that changed order', () => {
  const agb = { attachmentId: 1, name: 'AGB', delivery: 'merged' };
  const privacy = { attachmentId: 2, name: 'Datenschutz', delivery: 'merged' };
  const diff = diffVersions(version([], { attachments: [agb, privacy] }), version([], { attachments: [privacy, agb] }));
  expect(diff.unchanged).toBe(false);
  expect(diff.attachments).toEqual([{ type: 'moved', name: 'Datenschutz' }]);
});

it('compares the name, description and use case when both sides carry them', () => {
  const meta = { name: 'Hochzeit', description: '', useCase: 'wedding' };
  const before = version([], { meta });
  expect(diffVersions(before, version([], { meta: { ...meta, name: 'Hochzeit 2027' } })).fields.map((f) => f.field)).toEqual(['name']);
  // A saved version has no meta: nothing to compare there.
  expect(diffVersions(before, version([])).unchanged).toBe(true);
});

it('compares the declarations a signer confirms by key: added, removed, wording and required (#1446)', () => {
  const acceptance = { key: 'acceptance', required: true, text: { de: 'Ich stimme zu.', en: 'I agree.' } };
  const before = version([block(1, 'A')], {
    consents: [acceptance, { key: 'newsletter', required: false, text: { de: 'Newsletter ja.' } }],
  });
  const after = version([block(1, 'A')], {
    consents: [
      { ...acceptance, text: { de: 'Ich stimme ausdrücklich zu.', en: 'I agree.' } },
      { key: 'image_rights', required: true, text: { de: 'Fotos dürfen gezeigt werden.' } },
    ],
  });
  const diff = diffVersions(before, after);
  expect(diff.unchanged).toBe(false);
  expect(diff.clauses).toEqual([]);
  expect(diff.consents.map((c) => [c.type, c.key])).toEqual([
    ['changed', 'acceptance'], ['added', 'image_rights'], ['removed', 'newsletter'],
  ]);
  const changed = diff.consents[0];
  expect(changed.required).toBeUndefined();
  expect(changed.texts.map((t) => t.locale)).toEqual(['de']);
  expect(changed.texts[0].ops).toContainEqual({ type: 'add', text: 'ausdrücklich ' });

  // Only `required` flipped: a change without a text diff.
  const flipped = diffVersions(before, version([block(1, 'A')], {
    consents: [{ ...acceptance, required: false }, before.consents![1]],
  }));
  expect(flipped.consents).toEqual([{ type: 'changed', key: 'acceptance', required: false, texts: [] }]);
  expect(diffVersions(before, before).unchanged).toBe(true);
});
