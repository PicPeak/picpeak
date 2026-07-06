import React, { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

interface MarkdownContentProps {
  /** Raw markdown source. Empty/null → renders nothing. */
  source?: string | null;
  /** Wrapper className. Default lets the consumer style spacing. */
  className?: string;
}

// Sanitization allowlist — kept tight on purpose. The promo slot is
// admin-authored content rendered to gallery visitors, so the surface
// has to be conservative. Markdown source means contributors don't
// hand-write HTML in the first place; this is defense-in-depth.
const ALLOWED_TAGS = [
  'p', 'br', 'strong', 'em', 'b', 'i', 'u', 'del', 's',
  'a', 'ul', 'ol', 'li', 'blockquote',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'code', 'pre',
];
const ALLOWED_ATTR = ['href', 'title', 'target', 'rel'];

// Marked configuration:
//   gfm: true          → autolinks, strikethrough, tables (we don't allow tables in ALLOWED_TAGS so they sanitize out cleanly)
//   breaks: true       → newline = <br> (matches what an admin types in a textarea)
//   pedantic: false    → modern interpretation of edge cases
marked.setOptions({ gfm: true, breaks: true, pedantic: false });

/**
 * Render admin-authored markdown safely. Used by the gallery footer
 * promotional slot (#440) and any future admin-content surface that
 * needs more than plain text but less than a full WYSIWYG editor.
 *
 * Pipeline: marked.parse → DOMPurify with the allowlist above. Returns
 * null when the source is empty so callers can use it inline without
 * a wrapper-when-empty problem.
 */
export const MarkdownContent: React.FC<MarkdownContentProps> = ({ source, className }) => {
  const html = useMemo(() => {
    const md = (source ?? '').trim();
    if (!md) return '';
    const raw = marked.parse(md, { async: false }) as string;
    return DOMPurify.sanitize(raw, {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      ALLOW_DATA_ATTR: false,
      KEEP_CONTENT: true,
      // Force external links to noopener/noreferrer so admin-set URLs
      // can't tab-nap the gallery context.
      ADD_ATTR: ['target', 'rel'],
    });
  }, [source]);

  if (!html) return null;
  return (
    <div
      className={className}
      // Add target=_blank + rel safety to all <a> after sanitize. Doing
      // this with a hook would be cleaner but DOMPurify lacks a generic
      // "set attribute on tag" hook in this version, so post-process.
      dangerouslySetInnerHTML={{ __html: html.replace(
        /<a /g,
        '<a target="_blank" rel="noopener noreferrer nofollow" '
      ) }}
    />
  );
};
