/**
 * The brief of a customer without a project (issue 2678), on the customer
 * page. The page saves its form with its own button and its other records
 * (contacts, groups, documents) from their cards, so the brief does too.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/common';
import { BriefCard, useBriefEditor } from './BriefCard';

export const CustomerBriefCard: React.FC<{ customerId: number; canEdit: boolean }> = ({ customerId, canEdit }) => {
  const { t } = useTranslation();
  const editor = useBriefEditor({ kind: 'customers', id: customerId });
  const footer = canEdit && editor.dirty ? (
    <>
      <Button variant="ghost" size="sm" onClick={editor.discard} disabled={editor.save.isPending}>
        {t('briefs.discard', 'Discard')}
      </Button>
      <Button variant="primary" size="sm" isLoading={editor.save.isPending} onClick={() => editor.save.mutate()}>
        {t('briefs.save', 'Save brief')}
      </Button>
    </>
  ) : null;
  return <BriefCard editor={editor} canEdit={canEdit} footer={footer} />;
};
