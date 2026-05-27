/**
 * Customer dashboard branding card (#354 follow-up).
 *
 * Two toggles that govern what shows in the /customer/dashboard
 * header — the logo and the company-name text. Persisted under
 * setting_type='customer_surface' in app_settings via the dedicated
 * /admin/settings/customer-surface endpoint, kept separate from the
 * main BrandingPage save flow so toggling these doesn't drag the
 * full branding payload through a save cycle.
 *
 * Mounted from BrandingPage and only rendered when the customerPortal
 * feature flag is on — see CustomerDashboardBrandingSection in
 * BrandingPage.tsx.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { Save, Image as ImageIcon, Type, UserCog } from 'lucide-react';
import { Button, Card, Loading } from '../common';
import { api } from '../../config/api';

interface CustomerSurfaceSettings {
  customer_show_logo: boolean;
  customer_show_company_name: boolean;
}

const DEFAULTS: CustomerSurfaceSettings = {
  customer_show_logo: true,
  customer_show_company_name: true,
};

// Migration 092 seeds these as JSON-encoded booleans. Treat anything
// other than literal false as on, matching the backend defaults so a
// brand-new install (no row yet) shows the same UI as an existing one.
function withDefaults(raw: Partial<CustomerSurfaceSettings> | null | undefined): CustomerSurfaceSettings {
  return {
    customer_show_logo: raw?.customer_show_logo !== false,
    customer_show_company_name: raw?.customer_show_company_name !== false,
  };
}

interface ToggleProps {
  enabled: boolean;
  onChange: () => void;
  label: string;
  hint?: string;
  icon: React.ComponentType<{ className?: string }>;
}

const Toggle: React.FC<ToggleProps> = ({ enabled, onChange, label, hint, icon: Icon }) => (
  <label className="flex items-start justify-between gap-4 py-3 cursor-pointer">
    <div className="flex items-start gap-3 min-w-0">
      <Icon className="w-5 h-5 mt-0.5 text-neutral-500 dark:text-neutral-400 flex-shrink-0" />
      <div className="min-w-0">
        <div className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{label}</div>
        {hint && <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">{hint}</p>}
      </div>
    </div>
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      onClick={onChange}
      className="relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
      style={{ backgroundColor: enabled ? 'var(--color-accent, #5C8762)' : '#cbd5e1' }}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'}`}
      />
    </button>
  </label>
);

export const CustomerDashboardBrandingCard: React.FC = () => {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['admin-settings-customer-surface'],
    queryFn: async () => {
      const res = await api.get<Partial<CustomerSurfaceSettings>>('/admin/settings/customer-surface');
      return withDefaults(res.data);
    },
  });

  const [form, setForm] = useState<CustomerSurfaceSettings>(DEFAULTS);
  useEffect(() => { if (data) setForm(data); }, [data]);

  const saveMutation = useMutation({
    mutationFn: () => api.put('/admin/settings/customer-surface', form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-settings-customer-surface'] });
      // The customer-side session response (/api/customer/auth/session)
      // also bundles these as branding flags — invalidate so a customer
      // tab refresh picks up the new visibility on the next focus.
      qc.invalidateQueries({ queryKey: ['public-settings'] });
      toast.success(t('settings.customerSurface.saved', 'Customer dashboard branding saved'));
    },
    onError: () => toast.error(t('settings.customerSurface.error', 'Could not save settings')),
  });

  const toggle = (key: keyof CustomerSurfaceSettings) => {
    setForm((p) => ({ ...p, [key]: !p[key] }));
  };

  const isDirty = data
    ? form.customer_show_logo !== data.customer_show_logo
        || form.customer_show_company_name !== data.customer_show_company_name
    : false;

  if (isLoading) {
    return (
      <Card padding="md">
        <div className="py-6 flex justify-center"><Loading size="md" /></div>
      </Card>
    );
  }

  return (
    <Card padding="md">
      <div className="flex items-start gap-3 mb-4">
        <div className="w-10 h-10 rounded-lg bg-accent-soft text-on-accent-soft flex items-center justify-center flex-shrink-0">
          <UserCog className="w-5 h-5" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
            {t('settings.customerSurface.brandingTitle', 'Customer dashboard header')}
          </h2>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-0.5">
            {t(
              'settings.customerSurface.brandingHint',
              'Controls what shows in the header of /customer/dashboard. Public galleries and admin surfaces are not affected.',
            )}
          </p>
        </div>
      </div>

      <div className="divide-y divide-neutral-200 dark:divide-neutral-700">
        <Toggle
          enabled={form.customer_show_logo}
          onChange={() => toggle('customer_show_logo')}
          label={t('settings.customerSurface.showLogo', 'Show logo in customer header')}
          hint={t('settings.customerSurface.showLogoHint', 'Uses the same branding logo configured above.')}
          icon={ImageIcon}
        />
        <Toggle
          enabled={form.customer_show_company_name}
          onChange={() => toggle('customer_show_company_name')}
          label={t('settings.customerSurface.showCompanyName', 'Show company name in customer header')}
          hint={t('settings.customerSurface.showCompanyNameHint', 'Hide if your logo already includes the company name.')}
          icon={Type}
        />
      </div>

      <div className="flex justify-end mt-4 pt-4 border-t border-neutral-200 dark:border-neutral-700">
        <Button
          variant="primary"
          leftIcon={<Save className="w-4 h-4" />}
          isLoading={saveMutation.isPending}
          disabled={!isDirty || saveMutation.isPending}
          onClick={() => saveMutation.mutate()}
        >
          {t('settings.customerSurface.save', 'Save changes')}
        </Button>
      </div>
    </Card>
  );
};
