import React from 'react';
import { HelpCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../common';

/** Reopens the first-visit walkthrough (issue 2551). */
export const WalkthroughHelpButton: React.FC<{ onClick: () => void; className?: string }> = ({ onClick, className = '' }) => {
  const { t } = useTranslation();
  const label = t('gallery.walkthrough.help', 'Show the gallery guide');
  return (
    <Button
      variant="ghost"
      size="sm"
      className={`gallery-btn p-2 ${className}`}
      onClick={onClick}
      aria-label={label}
      title={label}
      data-tour="walkthrough-help"
    >
      <HelpCircle className="w-5 h-5" aria-hidden="true" />
    </Button>
  );
};
