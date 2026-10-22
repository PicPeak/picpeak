/**
 * Options every sanitize-html call shares.
 *
 * NON_TEXT_TAGS: sanitize-html's own default list plus `iframe`. No config
 * here allows <iframe>, and since 2.18.0 the content of a discarded one is
 * sanitized again as HTML, recursing once per nested <iframe>. In 2.18.0
 * about 1,000 of them (8 KB of input) overflowed the call stack; 2.18.1
 * caps the recursion at 8 levels. As a non-text tag its content is dropped
 * instead, in linear time, whatever the version does.
 */
const NON_TEXT_TAGS = ['script', 'style', 'textarea', 'option', 'xmp', 'iframe'];

module.exports = { NON_TEXT_TAGS };
