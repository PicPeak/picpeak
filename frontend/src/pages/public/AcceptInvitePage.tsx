import React, { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  User,
  Lock,
  Eye,
  EyeOff,
  CheckCircle,
  Mail,
  Shield,
  XCircle
} from 'lucide-react';
import { toast } from 'react-toastify';

import { Button, Input, Card, Loading } from '../../components/common';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';
import { api } from '../../config/api';

interface InvitationValidation {
  valid: boolean;
  email: string;
  role: string;
  expiresAt: string;
}

interface AcceptInvitePayload {
  username: string;
  password: string;
}

interface AcceptInviteResponse {
  message: string;
  email: string;
}

interface PasswordRequirement {
  label: string;
  met: boolean;
  test: (password: string) => boolean;
}

export const AcceptInvitePage: React.FC = () => {
  const { t } = useTranslation();
  const { formatDateTime: fmtDateTime } = useLocalizedDate();
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();

  const [formData, setFormData] = useState({
    username: '',
    password: '',
    confirmPassword: '',
  });
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [redirectCountdown, setRedirectCountdown] = useState<number | null>(null);

  // Validate invitation token
  const {
    data: invitation,
    isLoading: isValidating,
    error: validationError,
    isError
  } = useQuery<InvitationValidation>({
    queryKey: ['invitation', token],
    queryFn: async () => {
      const response = await api.get(`/invite/${token}`);
      return response.data;
    },
    enabled: !!token,
    retry: false,
  });

  // Accept invitation mutation
  const acceptMutation = useMutation({
    mutationFn: async (payload: AcceptInvitePayload) => {
      const response = await api.post<AcceptInviteResponse>(`/invite/${token}`, payload);
      return response.data;
    },
    onSuccess: (data) => {
      toast.success(data.message || t('acceptInvitation.success'));
      setRedirectCountdown(5);
    },
    onError: (error: any) => {
      const errorMessage = error.response?.data?.error || error.response?.data?.message;

      if (error.response?.status === 400) {
        // Validation errors
        if (error.response?.data?.errors) {
          const validationErrors: Record<string, string> = {};
          error.response.data.errors.forEach((err: { field: string; message: string }) => {
            validationErrors[err.field] = err.message;
          });
          setErrors(validationErrors);
        } else {
          toast.error(errorMessage || t('acceptInvitation.errors.genericError'));
        }
      } else if (error.response?.status === 422) {
        toast.error(errorMessage || t('acceptInvitation.errors.genericError'));
      } else if (error.response?.status === 404) {
        toast.error(t('acceptInvitation.invalidTokenMessage'));
      } else if (error.response?.status === 409) {
        toast.error(errorMessage || t('acceptInvitation.alreadyUsedMessage'));
      } else {
        toast.error(t('acceptInvitation.errors.genericError'));
      }
    },
  });

  // Password requirements
  const passwordRequirements: PasswordRequirement[] = useMemo(() => [
    {
      label: t('acceptInvitation.requirements.minLength'),
      met: false,
      test: (pwd: string) => pwd.length >= 12,
    },
    {
      label: t('acceptInvitation.requirements.uppercase'),
      met: false,
      test: (pwd: string) => /[A-Z]/.test(pwd),
    },
    {
      label: t('acceptInvitation.requirements.lowercase'),
      met: false,
      test: (pwd: string) => /[a-z]/.test(pwd),
    },
    {
      label: t('acceptInvitation.requirements.number'),
      met: false,
      test: (pwd: string) => /[0-9]/.test(pwd),
    },
    {
      label: t('acceptInvitation.requirements.special'),
      met: false,
      test: (pwd: string) => /[!@#$%^&*(),.?":{}|<>]/.test(pwd),
    },
  ], [t]);

  // Calculate password strength
  const passwordStrength = useMemo(() => {
    const metCount = passwordRequirements.filter(req => req.test(formData.password)).length;
    if (metCount === 0) return { level: 0, label: '', color: '' };
    if (metCount <= 2) return { level: 1, label: t('acceptInvitation.strength.weak'), color: 'bg-red-500' };
    if (metCount <= 3) return { level: 2, label: t('acceptInvitation.strength.fair'), color: 'bg-yellow-500' };
    if (metCount <= 4) return { level: 3, label: t('acceptInvitation.strength.good'), color: 'bg-blue-500' };
    return { level: 4, label: t('acceptInvitation.strength.strong'), color: 'bg-green-500' };
  }, [formData.password, passwordRequirements, t]);

  // Redirect countdown effect
  useEffect(() => {
    if (redirectCountdown === null) return;

    if (redirectCountdown === 0) {
      navigate('/admin/login');
      return;
    }

    const timer = setTimeout(() => {
      setRedirectCountdown(prev => (prev !== null ? prev - 1 : null));
    }, 1000);

    return () => clearTimeout(timer);
  }, [redirectCountdown, navigate]);

  // Validate username
  const validateUsername = (username: string): string | null => {
    if (!username) {
      return t('acceptInvitation.errors.usernameRequired');
    }
    if (username.length < 3) {
      return t('acceptInvitation.errors.usernameTooShort');
    }
    if (username.length > 50) {
      return t('acceptInvitation.errors.usernameTooLong');
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
      return t('acceptInvitation.errors.usernameInvalid');
    }
    return null;
  };

  // Validate form
  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {};

    const usernameError = validateUsername(formData.username);
    if (usernameError) {
      newErrors.username = usernameError;
    }

    if (!formData.password) {
      newErrors.password = t('acceptInvitation.errors.passwordRequired');
    } else {
      // Find the first failing requirement and show its specific error
      const failingRequirement = passwordRequirements.find(req => !req.test(formData.password));
      if (failingRequirement) {
        newErrors.password = failingRequirement.label;
      }
    }

    if (!formData.confirmPassword) {
      newErrors.confirmPassword = t('acceptInvitation.errors.confirmPasswordRequired');
    } else if (formData.password !== formData.confirmPassword) {
      newErrors.confirmPassword = t('acceptInvitation.errors.passwordsDoNotMatch');
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateForm()) {
      return;
    }

    acceptMutation.mutate({
      username: formData.username,
      password: formData.password,
    });
  };

  const handleInputChange = (field: string) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData(prev => ({ ...prev, [field]: e.target.value }));
    // Clear error when user starts typing
    if (errors[field]) {
      setErrors(prev => ({ ...prev, [field]: '' }));
    }
  };

  // Format role for display
  const formatRole = (role: string): string => {
    const roleKey = `admin.roles.${role}`;
    const translated = t(roleKey);
    // If translation not found, format the role nicely
    if (translated === roleKey) {
      return role.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    }
    return translated;
  };

  // Format expiration date — respects the admin-configured
  // `general_date_format` for the date half + 24-hour HH:mm for the
  // time half (was previously a hardcoded long-form en/locale string
  // that ignored the setting).
  const formatExpirationDate = (dateString: string): string => {
    try {
      return fmtDateTime(dateString);
    } catch {
      return dateString;
    }
  };

  // Loading state
  if (isValidating) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4" style={{ backgroundColor: 'var(--color-background, #fafafa)' }}>
        <div className="w-full max-w-md text-center">
          <Loading size="lg" text={t('acceptInvitation.validating')} />
        </div>
      </div>
    );
  }

  // Error state - invalid or expired token
  if (isError || !invitation?.valid) {
    const errorMessage = (validationError as any)?.response?.data?.error || t('acceptInvitation.invalidTokenMessage');

    return (
      <div className="min-h-screen flex items-center justify-center p-4" style={{ backgroundColor: 'var(--color-background, #fafafa)' }}>
        <div className="w-full max-w-md">
          <Card padding="lg">
            <div className="text-center">
              <div className="w-16 h-16 mx-auto mb-6 rounded-full bg-red-100 flex items-center justify-center">
                <XCircle className="w-8 h-8 text-red-600" />
              </div>
              <h1 className="text-2xl font-bold text-neutral-900 mb-2">
                {t('acceptInvitation.invalidToken')}
              </h1>
              <p className="text-neutral-600 mb-6">
                {errorMessage}
              </p>
              <p className="text-sm text-neutral-500 mb-6">
                {t('acceptInvitation.contactAdminMessage')}
              </p>
              <Button
                variant="primary"
                onClick={() => navigate('/admin/login')}
              >
                {t('acceptInvitation.goToLogin')}
              </Button>
            </div>
          </Card>
        </div>
      </div>
    );
  }

  // Success state - account created
  if (acceptMutation.isSuccess) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4" style={{ backgroundColor: 'var(--color-background, #fafafa)' }}>
        <div className="w-full max-w-md">
          <Card padding="lg">
            <div className="text-center">
              <div className="w-16 h-16 mx-auto mb-6 rounded-full bg-green-100 flex items-center justify-center">
                <CheckCircle className="w-8 h-8 text-green-600" />
              </div>
              <h1 className="text-2xl font-bold text-neutral-900 mb-2">
                {t('acceptInvitation.success')}
              </h1>
              <p className="text-neutral-600 mb-6">
                {t('acceptInvitation.successMessage')}
              </p>
              <p className="text-sm text-neutral-500 mb-6">
                {t('acceptInvitation.redirecting', { seconds: redirectCountdown })}
              </p>
              <Button
                variant="primary"
                onClick={() => navigate('/admin/login')}
              >
                {t('acceptInvitation.goToLogin')}
              </Button>
            </div>
          </Card>
        </div>
      </div>
    );
  }

  // Form state - valid invitation
  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ backgroundColor: 'var(--color-background, #fafafa)' }}>
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="text-center mb-8">
          <div
            className="w-[200px] h-[150px] mx-auto mb-6 rounded-2xl flex items-center justify-center"
            style={{ backgroundColor: '#eee6d2' }}
          >
            <img
              src="/picpeak-logo-transparent.png"
              alt="PicPeak"
              className="w-[180px] h-[130px] object-contain"
            />
          </div>
          <h1 className="text-3xl font-bold" style={{ color: 'var(--color-text, #171717)' }}>
            {t('acceptInvitation.title')}
          </h1>
          <p className="mt-2" style={{ color: 'var(--color-text, #171717)', opacity: 0.7 }}>
            {t('acceptInvitation.subtitle')}
          </p>
        </div>

        {/* Invitation Info Card */}
        <Card padding="md" className="mb-6">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-full bg-primary-100 flex items-center justify-center flex-shrink-0">
              <Mail className="w-5 h-5 text-primary-600" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-neutral-500">{t('acceptInvitation.invitedAs')}</p>
              <p className="font-medium text-neutral-900 truncate">{invitation.email}</p>
              <div className="flex items-center gap-2 mt-2">
                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                  <Shield className="w-3 h-3" />
                  {formatRole(invitation.role)}
                </span>
              </div>
              <p className="text-xs text-neutral-500 mt-2">
                {t('acceptInvitation.expiresAt', { date: formatExpirationDate(invitation.expiresAt) })}
              </p>
            </div>
          </div>
        </Card>

        {/* Registration Form */}
        <Card padding="lg">
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Username Field */}
            <div>
              <label htmlFor="username" className="block text-sm font-medium text-neutral-700 mb-1">
                {t('acceptInvitation.usernameLabel')}
              </label>
              <Input
                id="username"
                type="text"
                value={formData.username}
                onChange={handleInputChange('username')}
                error={errors.username}
                placeholder={t('acceptInvitation.usernamePlaceholder')}
                leftIcon={<User className="w-5 h-5 text-neutral-400" />}
                autoComplete="username"
                autoFocus
              />
              <p className="mt-1 text-xs text-neutral-500">
                {t('acceptInvitation.usernameHelp')}
              </p>
            </div>

            {/* Password Field */}
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-neutral-700 mb-1">
                {t('acceptInvitation.passwordLabel')}
              </label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  value={formData.password}
                  onChange={handleInputChange('password')}
                  error={errors.password}
                  placeholder={t('acceptInvitation.passwordPlaceholder')}
                  leftIcon={<Lock className="w-5 h-5 text-neutral-400" />}
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-3 text-neutral-400 hover:text-neutral-600 transition-colors"
                  tabIndex={-1}
                >
                  {showPassword ? (
                    <EyeOff className="w-5 h-5" />
                  ) : (
                    <Eye className="w-5 h-5" />
                  )}
                </button>
              </div>

              {/* Password Strength Indicator */}
              {formData.password && (
                <div className="mt-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-neutral-500">{t('acceptInvitation.passwordStrength')}</span>
                    <span className={`text-xs font-medium ${
                      passwordStrength.level <= 1 ? 'text-red-600' :
                      passwordStrength.level === 2 ? 'text-yellow-600' :
                      passwordStrength.level === 3 ? 'text-blue-600' :
                      'text-green-600'
                    }`}>
                      {passwordStrength.label}
                    </span>
                  </div>
                  <div className="h-1.5 bg-neutral-200 rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all duration-300 ${passwordStrength.color}`}
                      style={{ width: `${(passwordStrength.level / 4) * 100}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Password Requirements */}
              <div className="mt-3 space-y-1.5">
                <p className="text-xs font-medium text-neutral-600">{t('acceptInvitation.requirements.title')}</p>
                {passwordRequirements.map((req, index) => {
                  const isMet = req.test(formData.password);
                  return (
                    <div key={index} className="flex items-center gap-2">
                      {isMet ? (
                        <CheckCircle className="w-3.5 h-3.5 text-green-500" />
                      ) : (
                        <div className="w-3.5 h-3.5 rounded-full border border-neutral-300" />
                      )}
                      <span className={`text-xs ${isMet ? 'text-green-700' : 'text-neutral-500'}`}>
                        {req.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Confirm Password Field */}
            <div>
              <label htmlFor="confirmPassword" className="block text-sm font-medium text-neutral-700 mb-1">
                {t('acceptInvitation.confirmPasswordLabel')}
              </label>
              <div className="relative">
                <Input
                  id="confirmPassword"
                  type={showConfirmPassword ? 'text' : 'password'}
                  value={formData.confirmPassword}
                  onChange={handleInputChange('confirmPassword')}
                  error={errors.confirmPassword}
                  placeholder={t('acceptInvitation.confirmPasswordPlaceholder')}
                  leftIcon={<Lock className="w-5 h-5 text-neutral-400" />}
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  className="absolute right-3 top-3 text-neutral-400 hover:text-neutral-600 transition-colors"
                  tabIndex={-1}
                >
                  {showConfirmPassword ? (
                    <EyeOff className="w-5 h-5" />
                  ) : (
                    <Eye className="w-5 h-5" />
                  )}
                </button>
              </div>
              {formData.confirmPassword && formData.password === formData.confirmPassword && (
                <div className="flex items-center gap-1.5 mt-1.5">
                  <CheckCircle className="w-3.5 h-3.5 text-green-500" />
                  <span className="text-xs text-green-700">{t('acceptInvitation.passwordsMatch')}</span>
                </div>
              )}
            </div>

            {/* Submit Button */}
            <Button
              type="submit"
              variant="primary"
              size="lg"
              isLoading={acceptMutation.isPending}
              className="w-full"
            >
              {t('acceptInvitation.createAccount')}
            </Button>
          </form>
        </Card>

        {/* Footer */}
        <div className="text-center mt-8">
          <p className="text-sm" style={{ color: 'var(--color-text, #171717)', opacity: 0.7 }}>
            {t('acceptInvitation.alreadyHaveAccount')}{' '}
            <a
              href="/admin/login"
              className="hover:underline"
              style={{ color: 'var(--color-primary, #5C8762)' }}
            >
              {t('acceptInvitation.signIn')}
            </a>
          </p>
          <p className="text-xs mt-2" style={{ color: 'var(--color-text, #171717)', opacity: 0.5 }}>
            {t('adminLogin.poweredBy')}
          </p>
        </div>
      </div>
    </div>
  );
};

AcceptInvitePage.displayName = 'AcceptInvitePage';
