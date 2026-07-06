import React, { useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Input } from '../common';

interface FeedbackIdentityModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (name: string, email: string) => void;
  feedbackType: string;
}

export const FeedbackIdentityModal: React.FC<FeedbackIdentityModalProps> = ({
  isOpen,
  onClose,
  onSubmit,
  feedbackType
}) => {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const newErrors: Record<string, string> = {};

    if (!name.trim()) {
      newErrors.name = t('feedback.nameRequired', 'Name is required');
    }
    if (!email.trim()) {
      newErrors.email = t('feedback.emailRequired', 'Email is required');
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      newErrors.email = t('feedback.invalidEmail', 'Invalid email address');
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    onSubmit(name.trim(), email.trim());
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black bg-opacity-50" onClick={onClose} />
      <div className="relative bg-surface rounded-lg shadow-xl max-w-md w-full p-6">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-1 hover:bg-black/10 rounded-lg transition-colors"
        >
          <X className="w-5 h-5 text-muted-theme" />
        </button>

        <h2 className="text-lg font-semibold text-theme mb-2">
          {t('feedback.identityRequired', 'Your Information Required')}
        </h2>
        <p className="text-sm text-muted-theme mb-4">
          {t('feedback.identityReason', 'Please provide your name and email to submit {{type}}.', { type: feedbackType })}
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label={t('feedback.yourName', 'Your Name')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={errors.name}
            placeholder={t('feedback.namePlaceholder', 'Enter your name')}
            required
          />
          <Input
            type="email"
            label={t('feedback.yourEmail', 'Your Email')}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={errors.email}
            placeholder={t('feedback.emailPlaceholder', 'Enter your email')}
            required
          />
          <div className="flex gap-2 pt-2">
            <Button
              type="submit"
              variant="primary"
              className="flex-1"
            >
              {t('feedback.submitFeedback', 'Submit Feedback')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              className="flex-1"
            >
              {t('common.cancel', 'Cancel')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
};