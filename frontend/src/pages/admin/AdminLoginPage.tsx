import React, { useState, useEffect } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Lock, Mail, Eye, EyeOff, AlertCircle, ShieldCheck, KeyRound, ArrowLeft } from 'lucide-react';
import { toast } from 'react-toastify';
import { useTranslation } from 'react-i18next';

import { Button, Input, Card, ReCaptcha } from '../../components/common';
import { useAdminAuth } from '../../contexts';
import { authService } from '../../services/auth.service';
import { isMfaChallenge } from '../../types';
import { setupService } from '../../services/setup.service';
import { usePublicSettings } from '../../hooks/usePublicSettings';
import { useAdminDarkMode } from '../../contexts/AdminDarkModeContext';
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

  // Two-step MFA challenge state (issue #738). When the first step returns
  // { mfaRequired, mfaToken } we swap the form to a code entry step.
  const [step, setStep] = useState<'credentials' | 'mfa'>('credentials');
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  const [mfaError, setMfaError] = useState<string | null>(null);

  const { data: settingsData } = usePublicSettings();
  const { isDark } = useAdminDarkMode();

  const companyName = settingsData?.branding_company_name?.trim() || 'PicPeak';
  // Theme-aware logo: the login page honours the admin dark-mode preference
  // (and any branding_force_color_mode). NOTE the frame nuance — a framed
  // logo sits on a fixed cream plate (see render), so the light (dark-ink)
  // logo always reads there; only the frameless logo sits on the themed
  // (possibly dark) page background and needs the dark variant.
  const lightLogo = settingsData?.branding_logo_url?.trim();
  const darkLogo = settingsData?.branding_logo_url_dark?.trim();
  const loginFrameEnabled = settingsData?.branding_login_logo_frame_enabled !== false;
  const themedLogo = isDark ? (darkLogo || lightLogo) : (lightLogo || darkLogo);
  const logoUrl = loginFrameEnabled ? (lightLogo || darkLogo) : themedLogo;
  const resolvedLogoUrl = logoUrl || '/picpeak-logo-transparent.png';

  // Check for session expired message
  useEffect(() => {
    if (searchParams.get('session') === 'expired') {
      toast.info(t('adminLogin.sessionExpired'));
    }
  }, [searchParams, t]);

  // Fresh instance with no admin yet → send to first-run setup.
  const { data: setupStatus } = useQuery({
    queryKey: ['setup-status'],
    queryFn: setupService.getSetupStatus,
    retry: false,
    staleTime: Infinity,
  });
  if (setupStatus?.needsAdmin) {
    return <Navigate to="/setup" replace />;
  }

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
      // MFA enabled → move to the second step instead of logging in.
      if (isMfaChallenge(response)) {
        setMfaToken(response.mfaToken);
        setMfaCode('');
        setUseRecoveryCode(false);
        setMfaError(null);
        setStep('mfa');
        return;
      }
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

  const backToCredentials = () => {
    setStep('credentials');
    setMfaToken(null);
    setMfaCode('');
    setMfaError(null);
    setUseRecoveryCode(false);
  };

  const handleMfaSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    toast.dismiss();

    const code = mfaCode.trim();
    if (!code) {
      setMfaError(t('adminLogin.mfa.codeRequired'));
      return;
    }
    if (!mfaToken) {
      // Token lost somehow — restart the flow.
      toast.info(t('adminLogin.mfa.sessionExpired'));
      backToCredentials();
      return;
    }

    setIsLoading(true);
    setMfaError(null);

    try {
      const response = await authService.adminLoginMfa({ mfaToken, code });
      login(response.token, response.user);
      toast.success(t('adminLogin.loginSuccess'));
      setLoginSuccess(true);
    } catch (error: any) {
      const data = error.response?.data;
      const code = data?.code;
      if (error.response?.status === 423) {
        const retryAfter = data?.retryAfter;
        toast.error(
          retryAfter
            ? t('adminLogin.mfa.lockedRetry', { seconds: retryAfter })
            : t('adminLogin.mfa.locked')
        );
        backToCredentials();
      } else if (code === 'MFA_SESSION_EXPIRED') {
        toast.info(t('adminLogin.mfa.sessionExpired'));
        backToCredentials();
      } else if (code === 'MFA_INVALID') {
        setMfaError(t('adminLogin.mfa.invalidCode'));
      } else {
        setMfaError(data?.error || t('adminLogin.generalError'));
      }
    } finally {
      setIsLoading(false);
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
          {step === 'credentials' ? (
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
          ) : (
          <form onSubmit={handleMfaSubmit} className="space-y-6">
            <div className="text-center">
              <div className="mx-auto mb-3 w-12 h-12 rounded-full flex items-center justify-center bg-primary-50 dark:bg-primary-900/30">
                <ShieldCheck className="w-6 h-6" style={{ color: 'var(--color-primary, #5C8762)' }} />
              </div>
              <h2 className="text-lg font-semibold" style={{ color: 'var(--color-text, #171717)' }}>
                {t('adminLogin.mfa.title')}
              </h2>
              <p className="mt-1 text-sm" style={{ color: 'var(--color-text, #171717)', opacity: 0.7 }}>
                {useRecoveryCode ? t('adminLogin.mfa.recoverySubtitle') : t('adminLogin.mfa.subtitle')}
              </p>
            </div>

            {mfaError && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-red-800">{mfaError}</p>
              </div>
            )}

            <div>
              <label htmlFor="mfa-code" className="block text-sm font-medium text-neutral-700 mb-1">
                {useRecoveryCode ? t('adminLogin.mfa.recoveryCodeLabel') : t('adminLogin.mfa.codeLabel')}
              </label>
              <Input
                id="mfa-code"
                type="text"
                value={mfaCode}
                onChange={(e) => {
                  setMfaCode(e.target.value);
                  if (mfaError) setMfaError(null);
                }}
                placeholder={useRecoveryCode ? t('adminLogin.mfa.recoveryCodePlaceholder') : t('adminLogin.mfa.codePlaceholder')}
                leftIcon={<KeyRound className="w-5 h-5 text-neutral-400" />}
                inputMode={useRecoveryCode ? 'text' : 'numeric'}
                autoComplete="one-time-code"
                autoFocus
              />
            </div>

            <Button
              type="submit"
              variant="primary"
              size="lg"
              isLoading={isLoading}
              className="w-full"
            >
              {t('adminLogin.mfa.verify')}
            </Button>

            <div className="flex items-center justify-between text-sm">
              <button
                type="button"
                onClick={backToCredentials}
                className="inline-flex items-center gap-1 text-neutral-500 hover:text-neutral-700 transition-colors"
              >
                <ArrowLeft className="w-4 h-4" />
                {t('adminLogin.mfa.back')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setUseRecoveryCode((v) => !v);
                  setMfaCode('');
                  setMfaError(null);
                }}
                className="hover:underline"
                style={{ color: 'var(--color-primary, #5C8762)' }}
              >
                {useRecoveryCode ? t('adminLogin.mfa.useAuthenticator') : t('adminLogin.mfa.useRecoveryCode')}
              </button>
            </div>
          </form>
          )}
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
