import React, { useState } from 'react';
import { Lock, Eye, EyeOff } from 'lucide-react';
import { toast } from 'react-toastify';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { Button, Input, Modal, Notice } from '../common';
import { adminService } from '../../services/admin.service';

interface PasswordChangeModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const PasswordChangeModal: React.FC<PasswordChangeModalProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation();
  const [formData, setFormData] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: ''
  });
  const [showPasswords, setShowPasswords] = useState({
    current: false,
    new: false,
    confirm: false
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const changePasswordMutation = useMutation({
    mutationFn: adminService.changePassword,
    onSuccess: () => {
      toast.success(t('passwordChange.success'));
      // Full page reload so the browser picks up the new JWT cookie.
      // Same fix as MandatoryPasswordChangeModal — without this, the old
      // token gets rejected and causes a redirect loop.
      setTimeout(() => {
        window.location.href = '/admin/dashboard';
      }, 2000);
    },
    onError: (error: any) => {
      if (error.response?.data?.error) {
        toast.error(error.response.data.error);
      } else {
        toast.error(t('passwordChange.failed'));
      }
    }
  });

  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!formData.currentPassword) {
      newErrors.currentPassword = t('passwordChange.currentRequired');
    }

    if (!formData.newPassword) {
      newErrors.newPassword = t('passwordChange.newRequired');
    } else if (formData.newPassword.length < 6) {
      newErrors.newPassword = t('passwordChange.minLengthError');
    }

    if (!formData.confirmPassword) {
      newErrors.confirmPassword = t('passwordChange.confirmRequired');
    } else if (formData.newPassword !== formData.confirmPassword) {
      newErrors.confirmPassword = t('passwordChange.noMatch');
    }

    if (formData.currentPassword === formData.newPassword) {
      newErrors.newPassword = t('passwordChange.mustBeDifferent');
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!validateForm()) {
      return;
    }

    changePasswordMutation.mutate({
      currentPassword: formData.currentPassword,
      newPassword: formData.newPassword
    });
  };

  const handleInputChange = (field: keyof typeof formData) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData(prev => ({ ...prev, [field]: e.target.value }));
    // Clear error when user types
    if (errors[field]) {
      setErrors(prev => ({ ...prev, [field]: '' }));
    }
  };

  if (!isOpen) return null;

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      closeOnBackdrop={false}
      size="sm"
      title={t('passwordChange.title')}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
          >
            {t('passwordChange.cancel')}
          </Button>
          <Button
            type="submit"
            form="password-change-form"
            variant="primary"
            isLoading={changePasswordMutation.isPending}
          >
            {t('passwordChange.title')}
          </Button>
        </>
      }
    >
          <form id="password-change-form" onSubmit={handleSubmit} className="space-y-4">
            {/* Current Password */}
            <div>
              <label htmlFor="currentPassword" className="block text-sm font-medium text-body mb-1">
                {t('passwordChange.currentPassword')}
              </label>
              <div className="relative">
                <Input
                  id="currentPassword"
                  type={showPasswords.current ? 'text' : 'password'}
                  value={formData.currentPassword}
                  onChange={handleInputChange('currentPassword')}
                  error={errors.currentPassword}
                  placeholder={t('passwordChange.currentPasswordPlaceholder')}
                  leftIcon={<Lock className="w-5 h-5 text-faint" />}
                />
                <button
                  type="button"
                  onClick={() => setShowPasswords(prev => ({ ...prev, current: !prev.current }))}
                  className="absolute right-3 top-2 p-1 hover:bg-hover rounded"
                >
                  {showPasswords.current ? 
                    <EyeOff className="w-4 h-4 text-muted" /> : 
                    <Eye className="w-4 h-4 text-muted" />
                  }
                </button>
              </div>
            </div>

            {/* New Password */}
            <div>
              <label htmlFor="newPassword" className="block text-sm font-medium text-body mb-1">
                {t('passwordChange.newPassword')}
              </label>
              <div className="relative">
                <Input
                  id="newPassword"
                  type={showPasswords.new ? 'text' : 'password'}
                  value={formData.newPassword}
                  onChange={handleInputChange('newPassword')}
                  error={errors.newPassword}
                  placeholder={t('passwordChange.newPasswordPlaceholder')}
                  leftIcon={<Lock className="w-5 h-5 text-faint" />}
                />
                <button
                  type="button"
                  onClick={() => setShowPasswords(prev => ({ ...prev, new: !prev.new }))}
                  className="absolute right-3 top-2 p-1 hover:bg-hover rounded"
                >
                  {showPasswords.new ? 
                    <EyeOff className="w-4 h-4 text-muted" /> : 
                    <Eye className="w-4 h-4 text-muted" />
                  }
                </button>
              </div>
            </div>

            {/* Confirm Password */}
            <div>
              <label htmlFor="confirmPassword" className="block text-sm font-medium text-body mb-1">
                {t('passwordChange.confirmPassword')}
              </label>
              <div className="relative">
                <Input
                  id="confirmPassword"
                  type={showPasswords.confirm ? 'text' : 'password'}
                  value={formData.confirmPassword}
                  onChange={handleInputChange('confirmPassword')}
                  error={errors.confirmPassword}
                  placeholder={t('passwordChange.confirmPasswordPlaceholder')}
                  leftIcon={<Lock className="w-5 h-5 text-faint" />}
                />
                <button
                  type="button"
                  onClick={() => setShowPasswords(prev => ({ ...prev, confirm: !prev.confirm }))}
                  className="absolute right-3 top-2 p-1 hover:bg-hover rounded"
                >
                  {showPasswords.confirm ? 
                    <EyeOff className="w-4 h-4 text-muted" /> : 
                    <Eye className="w-4 h-4 text-muted" />
                  }
                </button>
              </div>
            </div>

            {/* Password Requirements */}
            <Notice tone="info" size="sm" title={t('passwordChange.requirements')}>
              <ul className="list-disc list-inside space-y-1">
                <li>{t('passwordChange.minLength')}</li>
                <li>{t('passwordChange.mustDiffer')}</li>
              </ul>
            </Notice>
          </form>
    </Modal>
  );
};