/**
 * The API rate limiter has a screen (#1337).
 *
 * Its six settings had a backend route and nothing in the UI, so installs
 * ran on a 300-per-15-minutes budget nobody could see (issue 1287). The
 * Security tab now shows the values in force, edits them through the hook's
 * state, and saves them with the tab's Save button. The test i18n renders the
 * English strings, so queries use those.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SecurityTab } from '../tabs/SecurityTab';
import { validateRateLimitSettings, type SecuritySettings, type RateLimitSettings } from '../hooks/useSettingsState';

const security: SecuritySettings = {
  password_min_length: 8, password_complexity: 'strong', session_timeout_minutes: 60,
  max_login_attempts: 5, attempt_window_minutes: 15, lockout_duration_minutes: 30,
  enable_recaptcha: false, recaptcha_site_key: '', recaptcha_secret_key: '',
};
const rateLimit: RateLimitSettings = {
  rate_limit_enabled: true, rate_limit_window_minutes: 15, rate_limit_max_requests: 300,
  rate_limit_auth_max_requests: 5, rate_limit_skip_authenticated: true, rate_limit_public_endpoints_only: false,
};

function mount(overrides: Partial<RateLimitSettings> = {}) {
  const setRateLimitSettings = vi.fn();
  const mutate = vi.fn();
  render(
    <SecurityTab
      securitySettings={security}
      setSecuritySettings={vi.fn()}
      rateLimitSettings={{ ...rateLimit, ...overrides }}
      setRateLimitSettings={setRateLimitSettings}
      saveSecurityMutation={{ mutate, isPending: false }}
      isDirty
      onDiscard={() => {}}
    />
  );
  return { setRateLimitSettings, mutate };
}

describe('SecurityTab rate limiter card', () => {
  it('shows the budget in force, defaults included', () => {
    mount();
    expect(screen.getByLabelText('Max requests per window')).toHaveValue(300);
    expect(screen.getByLabelText('Window (minutes)')).toHaveValue(15);
    expect(screen.getByLabelText('Failed logins per window')).toHaveValue(5);
    expect(screen.getByLabelText('Enable the API rate limiter')).toBeChecked();
    expect(screen.getByLabelText(/Do not count authenticated requests/)).toBeChecked();
    expect(screen.getByLabelText(/Count public endpoints only/)).not.toBeChecked();
    expect(screen.getByText(/The unit is the client IP/)).toBeInTheDocument();
  });

  it('edits go through the hook state as a functional update', () => {
    const { setRateLimitSettings } = mount();
    fireEvent.change(screen.getByLabelText('Max requests per window'), { target: { value: '5000' } });
    expect(setRateLimitSettings).toHaveBeenCalledTimes(1);
    const updater = setRateLimitSettings.mock.calls[0][0] as (prev: RateLimitSettings) => RateLimitSettings;
    expect(updater(rateLimit)).toEqual({ ...rateLimit, rate_limit_max_requests: 5000 });

    fireEvent.click(screen.getByLabelText(/Count public endpoints only/));
    const toggle = setRateLimitSettings.mock.calls[1][0] as (prev: RateLimitSettings) => RateLimitSettings;
    expect(toggle(rateLimit).rate_limit_public_endpoints_only).toBe(true);
  });

  it('the number fields carry the route\'s validation ranges', () => {
    mount();
    expect(screen.getByLabelText('Max requests per window')).toHaveAttribute('min', '10');
    expect(screen.getByLabelText('Max requests per window')).toHaveAttribute('max', '10000');
    expect(screen.getByLabelText('Window (minutes)')).toHaveAttribute('max', '60');
    expect(screen.getByLabelText('Failed logins per window')).toHaveAttribute('max', '100');
  });

  it('the tab\'s Save button saves the limiter along with the rest', () => {
    const { mutate } = mount();
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    expect(mutate).toHaveBeenCalledTimes(1);
  });
});

describe('rate limiter validation before save', () => {
  it('accepts the defaults and the route\'s bounds, rejects outside and non-integers', () => {
    expect(validateRateLimitSettings(rateLimit)).toBeNull();
    expect(validateRateLimitSettings({ ...rateLimit, rate_limit_window_minutes: 60, rate_limit_max_requests: 10000, rate_limit_auth_max_requests: 100 })).toBeNull();
    expect(validateRateLimitSettings({ ...rateLimit, rate_limit_window_minutes: 0 })).toBe('rate_limit_window_minutes');
    expect(validateRateLimitSettings({ ...rateLimit, rate_limit_max_requests: 10001 })).toBe('rate_limit_max_requests');
    expect(validateRateLimitSettings({ ...rateLimit, rate_limit_auth_max_requests: 0 })).toBe('rate_limit_auth_max_requests');
    // a cleared number field arrives as NaN
    expect(validateRateLimitSettings({ ...rateLimit, rate_limit_max_requests: Number('') })).toBe('rate_limit_max_requests');
  });
});
