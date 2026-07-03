import React from 'react';
import { CssTemplateEditor } from '../../../components/admin/CssTemplateEditor';

export const StylingTab: React.FC = () => {
  return (
    <div className="space-y-6">
      <CssTemplateEditor />
    </div>
  );
};
