import React, { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Key, Mail, Lock, Eye, EyeOff, AlertCircle, ArrowLeft, ArrowRight, Copy, Check, ExternalLink } from 'lucide-react';
import { toast } from 'react-toastify';
import { useTranslation } from 'react-i18next';

import { Button, Input, Card, Loading } from '../components/common';
import { useAdminAuth } from '../contexts';
import { setupService } from '../services/setup.service';
import { featureFlagsService, type FeatureFlags, type FeatureKey } from '../services/featureFlags.service';
import { PicpeakRestoreCard } from '../components/admin/PicpeakBackupCard';
import { SetupConfigStep } from '../components/admin/SetupConfigStep';
import { resolveLoginLogoClasses } from '../utils/loginLogoSize';
import type { AdminUser } from '../types';

// Where the first-run setup is documented, for the case where the server logs
// have already rotated away and the admin can no longer grep the token out.
const SETUP_DOCS_URL =
  'https://github.com/PicPeak/picpeak/blob/main/README.md#first-run--create-your-admin-account';

// "How will you use PicPeak?" — the opt-in feature groups shown after the admin
// account is created. galleries/analytics/userManagement are always on and not
// listed. Labels/descriptions reuse the existing Settings→Features i18n keys
// (`settings.features.<key>.title/description`) so translations stay in sync.
// Server-side applyDependencyRules resolves dependencies (e.g. Invoices pulls in
// Accounting) when we PUT the selection, so we only send the raw ticks.
const USAGE_GROUPS: { id: string; titleKey: string; features: FeatureKey[] }[] = [
  { id: 'crm', titleKey: 'setup.usageGroupCrm', features: ['quotes', 'contracts', 'bills', 'hoursLogging', 'customerPortal', 'calendar'] },
  { id: 'accounting', titleKey: 'setup.usageGroupAccounting', features: ['taxReport', 'incomingInvoices', 'expenses'] },
  { id: 'automation', titleKey: 'setup.usageGroupAutomation', features: ['reminderEmails', 'slideshow', 'workflows', 'whatsapp', 'incomingMail'] },
];
const ALL_USAGE_FEATURES: FeatureKey[] = USAGE_GROUPS.flatMap((g) => g.features);

// First-run screen. Reached on a fresh instance where no admin account exists
// yet — creates the first (super_admin) account from the browser using the
// one-time setup token printed to the server logs. Once an admin exists the
// endpoints self-close and this page redirects to the login.
//
// Split into two steps so the token-recovery guidance gets the space it needs:
//   1. paste the one-time setup token (with the `docker compose logs` recovery
//      command shown prominently right under the field)
//   2. choose the admin email + password
export const SetupPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { login } = useAdminAuth();

  const { data: status, isLoading: statusLoading, isError: statusError } = useQuery({
    queryKey: ['setup-status'],
    queryFn: setupService.getSetupStatus,
    retry: false,
    staleTime: Infinity,
  });

  const [step, setStep] = useState<'token' | 'account' | 'usage' | 'restore' | 'config'>('token');
  const [form, setForm] = useState({ token: '', email: '', password: '', confirm: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isVerifyingToken, setIsVerifyingToken] = useState(false);
  const [copied, setCopied] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [selectedFeatures, setSelectedFeatures] = useState<Set<FeatureKey>>(new Set());
  const [isSavingFeatures, setIsSavingFeatures] = useState(false);

  if (statusLoading) {
    return <Loading fullScreen />;
  }
  // Setup already done, OR the status couldn't be read (e.g. a transient 500) →
  // go to login rather than flashing the create-admin form on a configured
  // instance. Only render the wizard when we know an admin is genuinely missing.
  if (statusError || !status?.needsAdmin) {
    return <Navigate to="/admin/login" replace />;
  }

  const setField = (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((prev) => ({ ...prev, [field]: e.target.value }));
    if (errors[field]) setErrors((prev) => ({ ...prev, [field]: '' }));
  };

  const recoveryCommand = 'docker compose logs backend | grep -i "setup token"';

  const copyRecoveryCommand = async () => {
    try {
      await navigator.clipboard.writeText(recoveryCommand);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (e.g. non-secure context) — the command is still
      // visible for the user to copy by hand, so fail quietly.
    }
  };

  const validateToken = (): boolean => {
    const next: Record<string, string> = {};
    if (!form.token.trim()) next.token = t('setup.tokenRequired');
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const validateAccount = (): boolean => {
    const next: Record<string, string> = {};
    if (!form.email) next.email = t('setup.emailRequired');
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) next.email = t('setup.invalidEmail');
    if (!form.password) next.password = t('setup.passwordRequired');
    // Mirror the server's rule (validatePassword): >=8 chars with upper, lower
    // and a digit — so the user isn't bounced by the server after a green client.
    else if (!/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/.test(form.password)) next.password = t('setup.passwordRequirements');
    if (form.confirm !== form.password) next.confirm = t('setup.passwordMismatch');
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleTokenContinue = async (e: React.FormEvent) => {
    e.preventDefault();
    toast.dismiss();
    if (!validateToken()) return;
    // Verify the token server-side before advancing — a wrong token is caught
    // here at "Continue" rather than after the user has filled in the account
    // step. The token is checked, not consumed; createInitialAdmin still burns
    // it atomically on final submit.
    setIsVerifyingToken(true);
    setErrors({});
    try {
      await setupService.verifyToken(form.token.trim());
      setStep('account');
    } catch (error: any) {
      const httpStatus = error.response?.status;
      if (httpStatus === 429) {
        toast.error(t('setup.tooManyAttempts'));
      } else if (httpStatus === 409) {
        // Someone else finished setup first — send to login.
        navigate('/admin/login', { replace: true });
      } else {
        setErrors({ token: t('setup.invalidToken') });
      }
    } finally {
      setIsVerifyingToken(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    toast.dismiss();
    if (!validateAccount()) return;

    setIsSubmitting(true);
    setErrors({});
    try {
      const { user } = await setupService.createInitialAdmin({
        token: form.token.trim(),
        email: form.email.trim(),
        password: form.password,
      });
      // Cookie is set by the backend; register the session and enter the app.
      const adminUser: AdminUser = {
        id: user.id,
        username: user.username,
        email: user.email,
        mustChangePassword: false,
        role: { name: user.role.name, displayName: user.role.displayName ?? user.role.name },
      };
      login('', adminUser);
      toast.success(t('setup.success'));
      // Admin now exists and we're logged in (cookie set) — advance to the
      // opt-in "How will you use PicPeak?" step rather than jumping straight to
      // the dashboard. Authenticated calls (feature flags) work from here.
      setStep('usage');
    } catch (error: any) {
      const httpStatus = error.response?.status;
      const data = error.response?.data;
      // Map the server's field back to a translated message instead of
      // rendering its raw English error verbatim.
      const fieldKey: Record<string, string> = {
        token: 'setup.invalidToken',
        email: 'setup.invalidEmail',
        password: 'setup.passwordRequirements',
      };
      // A rejected token belongs to step 1 — send the user back there to fix it
      // rather than showing the error on a field the account step doesn't render.
      const bounceToTokenStep = (field: string) => {
        if (field === 'token') setStep('token');
      };
      if (httpStatus === 429) {
        toast.error(t('setup.tooManyAttempts'));
      } else if (httpStatus === 409) {
        // Someone else finished setup first — send to login.
        navigate('/admin/login', { replace: true });
      } else if (data?.field && fieldKey[data.field]) {
        setErrors({ [data.field]: t(fieldKey[data.field]) });
        bounceToTokenStep(data.field);
      } else if (Array.isArray(data?.errors) && data.errors.length) {
        const p = data.errors[0]?.path || data.errors[0]?.param;
        if (p && fieldKey[p]) {
          setErrors({ [p]: t(fieldKey[p]) });
          bounceToTokenStep(p);
        } else {
          setErrors({ form: t('setup.genericError') });
        }
      } else {
        setErrors({ form: t('setup.genericError') });
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const toggleFeature = (key: FeatureKey) => {
    setSelectedFeatures((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Persist the feature selection, then enter the app. Saving is best-effort —
  // if it fails the admin can still flip features later in Settings, so we don't
  // trap them on the setup screen.
  const finishSetup = async () => {
    setIsSavingFeatures(true);
    try {
      const flags: Partial<FeatureFlags> = {};
      for (const key of ALL_USAGE_FEATURES) flags[key] = selectedFeatures.has(key);
      await featureFlagsService.update(flags);
    } catch (_) {
      toast.warn(t('setup.featuresSaveFailed'));
    } finally {
      setIsSavingFeatures(false);
      // If the chosen features need config the wizard can collect (invoicing,
      // email), go to the config step; otherwise enter the app.
      const needsConfig =
        selectedFeatures.has('bills') ||
        selectedFeatures.has('reminderEmails') ||
        selectedFeatures.has('incomingMail') ||
        selectedFeatures.has('whatsapp');
      if (needsConfig) setStep('config');
      else navigate('/admin/dashboard', { replace: true });
    }
  };

  const stepNumber = step === 'token' ? 1 : step === 'account' ? 2 : 3;

  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ backgroundColor: '#fafafa' }}>
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          {/* On a fresh instance there are no branding settings yet, so use the
              bundled PicPeak logo — the same default the login page falls back
              to — on the cream brand plate. Size matches the login default
              (`medium`) so the two screens read identically. */}
          {(() => {
            const cls = resolveLoginLogoClasses(undefined);
            return (
              <div className={`${cls.frameOuter} mx-auto mb-6 rounded-2xl flex items-center justify-center`} style={{ backgroundColor: '#eee6d2' }}>
                <img src="/picpeak-logo-transparent.png" alt="PicPeak" className={`${cls.frameInner} object-contain`} />
              </div>
            );
          })()}
          <h1 className="text-3xl font-bold" style={{ color: '#171717' }}>{t('setup.title')}</h1>
          <p className="mt-2" style={{ color: '#171717', opacity: 0.7 }}>
            {step === 'token'
              ? t('setup.tokenStepSubtitle')
              : step === 'account'
                ? t('setup.accountStepSubtitle')
                : step === 'restore'
                  ? t('setup.restoreStepSubtitle')
                  : step === 'config'
                    ? t('setup.config.subtitle')
                    : t('setup.usageSubtitle')}
          </p>
          {(step === 'token' || step === 'account' || step === 'usage') && (
            <p className="mt-3 text-xs font-medium tracking-wide uppercase" style={{ color: '#171717', opacity: 0.5 }}>
              {t('setup.stepOf', { current: stepNumber, total: 3 })}
            </p>
          )}
        </div>

        <Card padding="lg">
          {errors.form && (
            <div className="mb-6 bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-800">{errors.form}</p>
            </div>
          )}

          {step === 'token' ? (
            <form onSubmit={handleTokenContinue} className="space-y-6">
              <div>
                <label htmlFor="setup-token" className="block text-sm font-medium text-neutral-700 mb-1">
                  {t('setup.tokenLabel')}
                </label>
                <Input
                  id="setup-token"
                  type="text"
                  value={form.token}
                  onChange={setField('token')}
                  error={errors.token}
                  placeholder={t('setup.tokenPlaceholder')}
                  leftIcon={<Key className="w-5 h-5 text-neutral-400" />}
                  autoFocus
                />
                <p className="mt-1 text-xs text-neutral-500">{t('setup.tokenHint')}</p>

                {/* Recovery guidance sits directly under the field it explains. */}
                <div className="mt-4 rounded-lg border border-neutral-200 bg-neutral-50 p-3">
                  <p className="text-xs font-medium text-neutral-600">{t('setup.tokenCommandLabel')}</p>
                  <div className="mt-2 flex items-center gap-2">
                    <code className="flex-1 overflow-x-auto whitespace-nowrap rounded bg-neutral-900 px-3 py-2 font-mono text-xs text-neutral-100">
                      {recoveryCommand}
                    </code>
                    <button
                      type="button"
                      onClick={copyRecoveryCommand}
                      className="flex-shrink-0 rounded-md border border-neutral-200 bg-white p-2 text-neutral-500 hover:text-neutral-700 transition-colors"
                      aria-label={t('setup.copyCommand')}
                      title={t('setup.copyCommand')}
                    >
                      {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
                    </button>
                  </div>
                  <a
                    href={SETUP_DOCS_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 inline-flex items-center gap-1 text-xs hover:underline"
                    style={{ color: 'var(--color-primary, #5C8762)' }}
                  >
                    {t('setup.tokenRotatedLink')}
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              </div>

              <Button type="submit" variant="primary" size="lg" isLoading={isVerifyingToken} className="w-full" rightIcon={<ArrowRight className="w-4 h-4" />}>
                {t('setup.continue')}
              </Button>
            </form>
          ) : step === 'account' ? (
            <form onSubmit={handleSubmit} className="space-y-6">
              <div>
                <label htmlFor="setup-email" className="block text-sm font-medium text-neutral-700 mb-1">
                  {t('setup.emailLabel')}
                </label>
                <Input
                  id="setup-email"
                  type="email"
                  value={form.email}
                  onChange={setField('email')}
                  error={errors.email}
                  placeholder={t('setup.emailPlaceholder')}
                  leftIcon={<Mail className="w-5 h-5 text-neutral-400" />}
                  autoComplete="email"
                  autoFocus
                />
              </div>

              <div>
                <label htmlFor="setup-password" className="block text-sm font-medium text-neutral-700 mb-1">
                  {t('setup.passwordLabel')}
                </label>
                <div className="relative">
                  <Input
                    id="setup-password"
                    type={showPassword ? 'text' : 'password'}
                    value={form.password}
                    onChange={setField('password')}
                    error={errors.password}
                    placeholder={t('setup.passwordPlaceholder')}
                    leftIcon={<Lock className="w-5 h-5 text-neutral-400" />}
                    autoComplete="new-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-3 text-neutral-400 hover:text-neutral-600 transition-colors"
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                  </button>
                </div>
              </div>

              <div>
                <label htmlFor="setup-confirm" className="block text-sm font-medium text-neutral-700 mb-1">
                  {t('setup.confirmLabel')}
                </label>
                <Input
                  id="setup-confirm"
                  type={showPassword ? 'text' : 'password'}
                  value={form.confirm}
                  onChange={setField('confirm')}
                  error={errors.confirm}
                  placeholder={t('setup.confirmPlaceholder')}
                  leftIcon={<Lock className="w-5 h-5 text-neutral-400" />}
                  autoComplete="new-password"
                />
              </div>

              <div className="flex gap-3">
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  onClick={() => { toast.dismiss(); setErrors({}); setStep('token'); }}
                  disabled={isSubmitting}
                  leftIcon={<ArrowLeft className="w-4 h-4" />}
                >
                  {t('setup.back')}
                </Button>
                <Button type="submit" variant="primary" size="lg" isLoading={isSubmitting} className="flex-1">
                  {t('setup.submit')}
                </Button>
              </div>
            </form>
          ) : step === 'usage' ? (
            <div className="space-y-6">
              <p className="rounded-lg bg-neutral-50 border border-neutral-200 px-3 py-2 text-xs text-neutral-600">
                {t('setup.usageAlwaysOn')}
              </p>

              <button
                type="button"
                onClick={() => setStep('restore')}
                className="w-full rounded-lg border border-dashed border-neutral-300 p-3 text-left hover:bg-neutral-50 transition-colors"
              >
                <span className="block text-sm font-medium text-neutral-800">{t('setup.restoreEntry')}</span>
                <span className="block text-xs text-neutral-500">{t('setup.restoreEntryHint')}</span>
              </button>

              {USAGE_GROUPS.map((group) => (
                <div key={group.id}>
                  <h3 className="text-sm font-semibold text-neutral-800 mb-2">{t(group.titleKey)}</h3>
                  <div className="space-y-2">
                    {group.features.map((key) => (
                      <label
                        key={key}
                        className="flex items-start gap-3 rounded-lg border border-neutral-200 p-3 cursor-pointer hover:bg-neutral-50 transition-colors"
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5 h-4 w-4 rounded border-neutral-300"
                          checked={selectedFeatures.has(key)}
                          onChange={() => toggleFeature(key)}
                        />
                        <span className="min-w-0">
                          <span className="block text-sm font-medium text-neutral-800">
                            {t(`settings.features.${key}.title`)}
                          </span>
                          <span className="block text-xs text-neutral-500">
                            {t(`settings.features.${key}.description`)}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}

              {selectedFeatures.has('bills') && !selectedFeatures.has('taxReport') && (
                <p className="text-xs text-neutral-500">{t('setup.usageDepsNote')}</p>
              )}

              <Button
                type="button"
                variant="primary"
                size="lg"
                isLoading={isSavingFeatures}
                className="w-full"
                onClick={finishSetup}
              >
                {selectedFeatures.size > 0 ? t('setup.finish') : t('setup.usageSkip')}
              </Button>
            </div>
          ) : step === 'restore' ? (
            <div className="space-y-6">
              <p className="text-sm text-neutral-600">{t('setup.restoreIntro')}</p>
              <PicpeakRestoreCard />
              <Button
                type="button"
                variant="outline"
                size="lg"
                onClick={() => setStep('usage')}
                leftIcon={<ArrowLeft className="w-4 h-4" />}
              >
                {t('setup.back')}
              </Button>
            </div>
          ) : (
            <SetupConfigStep
              selectedFeatures={selectedFeatures}
              onDone={() => navigate('/admin/dashboard', { replace: true })}
            />
          )}
        </Card>
      </div>
    </div>
  );
};

SetupPage.displayName = 'SetupPage';
