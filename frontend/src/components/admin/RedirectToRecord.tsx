import React from 'react';
import { Navigate, useLocation, useParams } from 'react-router-dom';

/**
 * A retired `/:id/edit` URL: a document's page is its editor now (one page
 * per document), so old links and bookmarks land on it (UX.md § 9).
 */
export const RedirectToRecord: React.FC<{ base: string }> = ({ base }) => {
  const { id } = useParams<{ id: string }>();
  const { search, hash } = useLocation();
  return <Navigate to={`${base}/${id}${search}${hash}`} replace />;
};
