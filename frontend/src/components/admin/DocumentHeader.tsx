import React from 'react';

interface DocumentHeaderProps {
  /** The document number, or "New quote" before it exists. */
  title: React.ReactNode;
  /** The status pill (`<Badge>`). */
  status?: React.ReactNode;
  /** One line under the title: who it is for, when it was created/sent. */
  meta?: React.ReactNode;
  /** In UX.md § 1 order: ⋯ menu, view/preview, the primary action of the moment. */
  actions?: React.ReactNode;
}

/**
 * The header of a CRM document page (quote, invoice, contract, newsletter):
 * the same anatomy as the gallery header. One page per document — it is the
 * editor while the document is a draft and read-only once it has gone out —
 * so the header never changes between the two.
 */
export const DocumentHeader: React.FC<DocumentHeaderProps> = ({ title, status, meta, actions }) => (
  <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 mb-4">
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-bold text-heading break-words">{title}</h1>
        {status}
      </div>
      {meta && <div className="mt-1 text-sm text-muted flex flex-wrap gap-x-2 gap-y-1">{meta}</div>}
    </div>
    {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
  </div>
);
