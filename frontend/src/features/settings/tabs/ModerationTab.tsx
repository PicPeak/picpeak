import React from 'react';
import { WordFilterManager } from '../../../components/admin/WordFilterManager';

export const ModerationTab: React.FC = () => {
  return (
    <div className="space-y-6">
      <WordFilterManager />
    </div>
  );
};
