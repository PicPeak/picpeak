'use strict';

/**
 * The plain-text line of a "here is your code" mail, per language. Shared by
 * the mails that are composed in code rather than from a template (guest
 * recovery, public contract / quote verification), so their wording and the
 * 15-minute lifetime they state cannot drift apart.
 */
const VERIFICATION_CODE_TEXT = {
  en: (code) => `Your verification code is ${code}. It expires in 15 minutes.`,
  de: (code) => `Ihr Bestätigungscode lautet ${code}. Er ist 15 Minuten gültig.`,
  pt: (code) => `Seu código de verificação é ${code}. Ele expira em 15 minutos.`,
};

module.exports = { VERIFICATION_CODE_TEXT };
