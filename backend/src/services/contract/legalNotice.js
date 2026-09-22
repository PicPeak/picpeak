'use strict';

/**
 * The legal notice a contract is signed under (#1446): what kind of
 * signature this is, and what it is not. Configurable per language in
 * `crm_contracts_legal_notice` ({ en, de }); a language left empty falls back
 * to the default below.
 *
 * It is copied into the content snapshot at send, so the notice is part of
 * what is signed and hashed, and the signing page and the certificate print
 * the frozen text — never a later edit of the setting.
 */

const { getAppSetting } = require('../../utils/appSettings');

const MAX = 2000;

const DEFAULT_LEGAL_NOTICE = Object.freeze({
  en: 'Signed with a simple electronic signature: each signer confirmed their email address with a one-time code, '
    + 'and every step is recorded in a hash-chained signing log. This is not an advanced or qualified electronic '
    + 'signature. Contracts that the law requires in written form must be signed on paper.',
  de: 'Unterzeichnet mit einer einfachen elektronischen Signatur: Jede unterzeichnende Person hat ihre E-Mail-Adresse '
    + 'mit einem Einmalcode bestätigt, und jeder Schritt ist in einem hash-verketteten Protokoll festgehalten. Dies ist '
    + 'keine fortgeschrittene oder qualifizierte elektronische Signatur. Verträge, für die das Gesetz die Schriftform '
    + 'verlangt, müssen auf Papier unterzeichnet werden.',
});

/** The notice as configured now, every language filled in. */
async function currentLegalNotice() {
  const raw = await getAppSetting('crm_contracts_legal_notice', null);
  const configured = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const locale of Object.keys(DEFAULT_LEGAL_NOTICE)) {
    const value = typeof configured[locale] === 'string' ? configured[locale].trim().slice(0, MAX) : '';
    out[locale] = value || DEFAULT_LEGAL_NOTICE[locale];
  }
  return out;
}

/** A frozen notice in a language, falling back to the other one; null when none was frozen. */
function pickNotice(notice, locale) {
  if (!notice || typeof notice !== 'object') return null;
  return notice[locale] || notice.en || notice.de || null;
}

module.exports = { DEFAULT_LEGAL_NOTICE, currentLegalNotice, pickNotice };
