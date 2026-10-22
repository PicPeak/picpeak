/**
 * Options every sanitize-html call shares.
 *
 * NON_TEXT_TAGS: sanitize-html's own default list plus `iframe`. No config
 * here allows <iframe>, and since 2.18.0 the content of a discarded one is
 * sanitized again as HTML, recursing once per nested <iframe>: about 1,000
 * of them (8 KB of input) overflow the call stack. As a non-text tag its
 * content is dropped instead, in linear time.
 */
const NON_TEXT_TAGS = ['script', 'style', 'textarea', 'option', 'xmp', 'iframe'];

module.exports = { NON_TEXT_TAGS };
