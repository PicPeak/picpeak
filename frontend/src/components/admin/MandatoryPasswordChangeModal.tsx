import React, { useState } from 'react';
import { Lock, Eye, EyeOff, AlertCircle } from 'lucide-react';
import { toast } from 'react-toastify';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { Button, Input, Card } from '../common';
import { adminService } from '../../services/admin.service';
import { useAdminAuth } from '../../contexts';

export const MandatoryPasswordChangeModal: React.FC = () => {
  const { t } = useTranslation();
  const { updatePasswordChanged } = useAdminAuth();
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
      toast.success(t('mandatoryPasswordChange.success'));
      // Force a full page reload so the browser picks up the new JWT cookie
      // set by the backend. A React state update alone causes a race condition
      // where the auth context checks the session before the cookie is stored.
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
    } else if (formData.newPassword.length < 12) {
      newErrors.newPassword = t('mandatoryPasswordChange.minLengthError');
    } else {
      // Check for character types
      if (!/[a-z]/.test(formData.newPassword)) {
        newErrors.newPassword = t('mandatoryPasswordChange.mustContainLowercase');
      } else if (!/[A-Z]/.test(formData.newPassword)) {
        newErrors.newPassword = t('mandatoryPasswordChange.mustContainUppercase');
      } else if (!/[0-9]/.test(formData.newPassword)) {
        newErrors.newPassword = t('mandatoryPasswordChange.mustContainNumbersError');
      } else if (!/[!@#$%^&*()_+\-=\[\]{}|;:,.<>?]/.test(formData.newPassword)) {
        newErrors.newPassword = t('mandatoryPasswordChange.mustContainSpecialError');
      }
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

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <Card className="w-full max-w-md">
        <div className="p-6">
          <div className="mb-6 text-center">
            <div className="mx-auto w-12 h-12 bg-amber-100 rounded-full flex items-center justify-center mb-4">
              <AlertCircle className="w-6 h-6 text-amber-600" />
            </div>
            <h2 className="text-xl font-semibold text-neutral-900 mb-2">{t('mandatoryPasswordChange.title')}</h2>
            <p className="text-sm text-neutral-600">
              {t('mandatoryPasswordChange.description')}
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Current Password */}
            <div>
              <label htmlFor="currentPassword" className="block text-sm font-medium text-neutral-700 mb-1">
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
                  leftIcon={<Lock className="w-5 h-5 text-neutral-400" />}
                />
                <button
                  type="button"
                  onClick={() => setShowPasswords(prev => ({ ...prev, current: !prev.current }))}
                  className="absolute right-3 top-2 p-1 hover:bg-neutral-100 dark:hover:bg-neutral-700 rounded"
                >
                  {showPasswords.current ? 
                    <EyeOff className="w-4 h-4 text-neutral-500" /> : 
                    <Eye className="w-4 h-4 text-neutral-500" />
                  }
                </button>
              </div>
            </div>

            {/* New Password */}
            <div>
              <label htmlFor="newPassword" className="block text-sm font-medium text-neutral-700 mb-1">
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
                  leftIcon={<Lock className="w-5 h-5 text-neutral-400" />}
                />
                <button
                  type="button"
                  onClick={() => setShowPasswords(prev => ({ ...prev, new: !prev.new }))}
                  className="absolute right-3 top-2 p-1 hover:bg-neutral-100 dark:hover:bg-neutral-700 rounded"
                >
                  {showPasswords.new ? 
                    <EyeOff className="w-4 h-4 text-neutral-500" /> : 
                    <Eye className="w-4 h-4 text-neutral-500" />
                  }
                </button>
              </div>
            </div>

            {/* Confirm Password */}
            <div>
              <label htmlFor="confirmPassword" className="block text-sm font-medium text-neutral-700 mb-1">
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
                  leftIcon={<Lock className="w-5 h-5 text-neutral-400" />}
                />
                <button
                  type="button"
                  onClick={() => setShowPasswords(prev => ({ ...prev, confirm: !prev.confirm }))}
                  className="absolute right-3 top-2 p-1 hover:bg-neutral-100 dark:hover:bg-neutral-700 rounded"
                >
                  {showPasswords.confirm ? 
                    <EyeOff className="w-4 h-4 text-neutral-500" /> : 
                    <Eye className="w-4 h-4 text-neutral-500" />
                  }
                </button>
              </div>
            </div>

            {/* Password Requirements */}
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
                <div className="text-sm text-blue-800">
                  <p className="font-medium">{t('passwordChange.requirements')}</p>
                  <ul className="list-disc list-inside mt-1 space-y-1">
                    <li>{t('mandatoryPasswordChange.minLength')}</li>
                    <li>{t('mandatoryPasswordChange.mustContainUpperLower')}</li>
                    <li>{t('mandatoryPasswordChange.mustContainNumbers')}</li>
                    <li>{t('mandatoryPasswordChange.mustContainSpecial')}</li>
                    <li>{t('passwordChange.mustDiffer')}</li>
                  </ul>
                </div>
              </div>
            </div>

            {/* Action Button */}
            <div className="pt-2">
              <Button
                type="submit"
                variant="primary"
                className="w-full"
                isLoading={changePasswordMutation.isPending}
              >
                {t('passwordChange.title')}
              </Button>
            </div>
          </form>
        </div>
      </Card>
    </div>
  );
};