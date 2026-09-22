/**
 * "Show only if…" for a contract template clause (#1445): the clause body
 * wrapped, in every language, in `{{#if key}}…{{/if}}` (the value is filled
 * in) or `{{#unless key}}…{{/unless}}` (the value is empty). That is the
 * whole rule language — one key, one test, no nesting — and the backend
 * evaluates exactly that; this module only writes and reads the wrapper.
 */
import type { LocaleText } from '../../../services/contractTemplates.service';

export interface ClauseCondition {
  kind: 'if' | 'unless';
  key: string;
}

const WRAPPED = /^\{\{\s*#(if|unless)\s+(\w+)\s*\}\}([\s\S]*)\{\{\s*\/\1\s*\}\}$/;
const ANY_TAG = /\{\{\s*[#/](?:if|unless)\b/;

/** The condition wrapping `text` whole, or null (plain text, or a partial/nested block). */
export function readTextCondition(text: string): (ClauseCondition & { inner: string }) | null {
  const match = WRAPPED.exec(text.trim());
  if (!match || ANY_TAG.test(match[3])) return null;
  return { kind: match[1] as ClauseCondition['kind'], key: match[2], inner: match[3] };
}

const filled = (body: LocaleText) => Object.entries(body).filter(([, text]) => typeof text === 'string' && text.trim() !== '') as Array<[keyof LocaleText, string]>;

/**
 * The clause's condition: the one every language is wrapped in, null when
 * none is, `'mixed'` when the languages disagree (or a text has a block of
 * its own inside) — the builder then offers to replace it.
 */
export function readCondition(body: LocaleText): ClauseCondition | null | 'mixed' {
  const texts = filled(body);
  if (!texts.length) return null;
  const conditions = texts.map(([, text]) => readTextCondition(text));
  if (conditions.every((c) => c === null)) return ANY_TAG.test(texts.map(([, text]) => text).join('')) ? 'mixed' : null;
  const [first] = conditions;
  if (first && conditions.every((c) => c && c.kind === first.kind && c.key === first.key)) {
    return { kind: first.kind, key: first.key };
  }
  return 'mixed';
}

/** `body` with its wrapper removed from every language. */
export function unwrapCondition(body: LocaleText): LocaleText {
  const out: LocaleText = {};
  for (const [locale, text] of Object.entries(body) as Array<[keyof LocaleText, string | undefined]>) {
    if (typeof text !== 'string') continue;
    const current = readTextCondition(text);
    out[locale] = current ? current.inner : text;
  }
  return out;
}

/** `body` wrapped in `condition` in every language that has text (null removes it). */
export function applyCondition(body: LocaleText, condition: ClauseCondition | null): LocaleText {
  const plain = unwrapCondition(body);
  if (!condition) return plain;
  const out: LocaleText = {};
  for (const [locale, text] of Object.entries(plain) as Array<[keyof LocaleText, string | undefined]>) {
    if (typeof text !== 'string') continue;
    out[locale] = text.trim() === ''
      ? text
      : `{{#${condition.kind} ${condition.key}}}${text}{{/${condition.kind}}}`;
  }
  return out;
}
