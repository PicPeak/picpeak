import React, { useState, useEffect } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { Lock, Mail, Eye, EyeOff, AlertCircle } from 'lucide-react';
import { toast } from 'react-toastify';
import { useTranslation } from 'react-i18next';

import { Button, Input, Card, ReCaptcha } from '../../components/common';
import { useAdminAuth } from '../../contexts';
import { authService } from '../../services/auth.service';
import { usePublicSettings } from '../../hooks/usePublicSettings';
import { resolveLoginLogoClasses } from '../../utils/loginLogoSize';
import { api } from '../../config/api';

export const AdminLoginPage: React.FC = () => {
  const { t } = useTranslation();
  const { isAuthenticated, login } = useAdminAuth();
  const [searchParams] = useSearchParams();
  
  const [formData, setFormData] = useState({
    email: '',
    password: '',
  });
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loginSuccess, setLoginSuccess] = useState(false);
  const [recaptchaToken, setRecaptchaToken] = useState<string | null>(null);

  const { data: settingsData } = usePublicSettings();

  const companyName = settingsData?.branding_company_name?.trim() || 'PicPeak';
  const logoUrl = settingsData?.branding_logo_url?.trim();
  const resolvedLogoUrl = logoUrl
    ? (logoUrl.startsWith('http') ? logoUrl : logoUrl)
    : '/picpeak-logo-transparent.png';

  // Check for session expired message
  useEffect(() => {
    if (searchParams.get('session') === 'expired') {
      toast.info(t('adminLogin.sessionExpired'));
    }
  }, [searchParams, t]);

  // Redirect if already authenticated or login successful
  if (isAuthenticated || loginSuccess) {
    return <Navigate to="/admin/dashboard" replace />;
  }

  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!formData.email) {
      newErrors.email = t('adminLogin.emailRequired');
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      newErrors.email = t('adminLogin.invalidEmail');
    }

    if (!formData.password) {
      newErrors.password = t('adminLogin.passwordRequired');
    } else if (formData.password.length < 6) {
      newErrors.password = t('adminLogin.passwordMinLength');
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    toast.dismiss();
    
    if (!validateForm()) {
      return;
    }

    setIsLoading(true);
    setErrors({});

    try {
      const response = await authService.adminLogin({
        ...formData,
        recaptchaToken
      });
      login(response.token, response.user);
      toast.success(t('adminLogin.loginSuccess'));
      setLoginSuccess(true);
      } catch (error: any) {
        // Login error handled by UI notification
        
        // Handle network errors gracefully
        if (error.code === 'ERR_NETWORK' || error.code === 'ERR_CONNECTION_RESET') {
        // Check if we actually got logged in despite the error
        try {
          const sessionResponse = await api.get<{ valid: boolean; type: string }>('/auth/session');
          if (sessionResponse.data?.valid && sessionResponse.data.type === 'admin') {
            setLoginSuccess(true);
            return;
          }
        } catch (sessionError) {
          // Ignore secondary failure, we'll surface the original network error
        }
        toast.error(t('adminLogin.networkError'));
      } else if (error.response?.status === 429) {
        toast.error(t('adminLogin.tooManyAttempts'));
      } else if (error.response?.status === 401) {
        setErrors({ form: t('adminLogin.invalidCredentials') });
      } else {
        toast.error(t('adminLogin.generalError'));
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleInputChange = (field: string) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData(prev => ({ ...prev, [field]: e.target.value }));
    // Clear error when user starts typing
    if (errors[field]) {
      setErrors(prev => ({ ...prev, [field]: '' }));
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ backgroundColor: 'var(--color-background, #fafafa)' }}>
      <div className="w-full max-w-md">
        {/* Logo/Header — frame visibility and size are admin-controllable
            via Branding → "Login pages logo" settings. Both knobs apply
            to /admin/login and /customer/login exclusively. */}
        <div className="text-center mb-8">
          {(() => {
            const cls = resolveLoginLogoClasses(settingsData?.branding_login_logo_size);
            const showFrame = settingsData?.branding_login_logo_frame_enabled !== false;
            return showFrame ? (
              <div
                className={`${cls.frameOuter} mx-auto mb-6 rounded-2xl flex items-center justify-center`}
                style={{ backgroundColor: '#eee6d2' }}
              >
                <img
                  src={resolvedLogoUrl}
                  alt={companyName}
                  className={`${cls.frameInner} object-contain`}
                />
              </div>
            ) : (
              <img
                src={resolvedLogoUrl}
                alt={companyName}
                className={`${cls.bare} object-contain mx-auto mb-6`}
              />
            );
          })()}
          <h1 className="text-3xl font-bold" style={{ color: 'var(--color-text, #171717)' }}>{t('adminLogin.title')}</h1>
          <p className="mt-2" style={{ color: 'var(--color-text, #171717)', opacity: 0.7 }}>{t('adminLogin.subtitle')}</p>
        </div>

        {/* Login Form */}
        <Card padding="lg">
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Form Error */}
            {errors.form && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-red-800">{errors.form}</p>
              </div>
            )}

            {/* Email Field */}
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-neutral-700 mb-1">
                {t('adminLogin.emailLabel')}
              </label>
              <Input
                id="email"
                type="email"
                value={formData.email}
                onChange={handleInputChange('email')}
                error={errors.email}
                placeholder={t('adminLogin.emailPlaceholder')}
                leftIcon={<Mail className="w-5 h-5 text-neutral-400" />}
                autoComplete="email"
                autoFocus
              />
            </div>

            {/* Password Field */}
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-neutral-700 mb-1">
                {t('adminLogin.passwordLabel')}
              </label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  value={formData.password}
                  onChange={handleInputChange('password')}
                  error={errors.password}
                  placeholder={t('adminLogin.passwordPlaceholder')}
                  leftIcon={<Lock className="w-5 h-5 text-neutral-400" />}
                  autoComplete="current-password"
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
            </div>

            {/* Remember Me */}
            <div className="flex items-center justify-between">
              <label className="flex items-center">
                <input
                  type="checkbox"
                  className="w-4 h-4 text-accent border-neutral-300 rounded focus:ring-primary-500"
                />
                <span className="ml-2 text-sm text-neutral-700">{t('adminLogin.rememberMe')}</span>
              </label>
            </div>

            {/* reCAPTCHA */}
            <ReCaptcha
              onChange={setRecaptchaToken}
              onExpired={() => setRecaptchaToken(null)}
            />

            {/* Submit Button */}
            <Button
              type="submit"
              variant="primary"
              size="lg"
              isLoading={isLoading}
              className="w-full"
            >
              {t('adminLogin.signIn')}
            </Button>
          </form>
        </Card>

        {/* Footer */}
        <div className="text-center mt-8">
          <p className="text-sm" style={{ color: 'var(--color-text, #171717)', opacity: 0.7 }}>
            {t('adminLogin.needHelp')}{' '}
            <a 
              href={`mailto:${settingsData?.branding_support_email || 'support@example.com'}`} 
              className="hover:underline"
              style={{ color: 'var(--color-primary, #5C8762)' }}
            >
              {settingsData?.branding_support_email || 'support@example.com'}
            </a>
          </p>
          <p className="text-xs mt-2" style={{ color: 'var(--color-text, #171717)', opacity: 0.5 }}>
            {t('adminLogin.poweredBy')}
          </p>
        </div>

        {/* Development Hint */}
        {import.meta.env.DEV && (
          <div className="mt-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <p className="text-sm text-blue-800 text-center">
              {t('adminLogin.devModeHint')}
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

AdminLoginPage.displayName = 'AdminLoginPage';
