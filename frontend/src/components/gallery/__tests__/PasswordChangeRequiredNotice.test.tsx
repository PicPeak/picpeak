/**
 * A gallery admin preview refused with 403 MUST_CHANGE_PASSWORD has to say so.
 *
 * The backend started denying the preview for a flagged admin, but the gallery
 * rendered that as "Failed to load photos" with a Retry that cannot succeed,
 * or as the gallery-not-found page for a draft. The admin had no way to tell
 * that a password change was all that stood in the way.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { PasswordChangeRequiredNotice } from '../PasswordChangeRequiredNotice';
import { isAdminSessionExpired, isPasswordChangeRequired } from '../../../utils/passwordChangeRequired';

const axiosError = (status: number, code?: string) => ({ response: { status, data: { code } } });

describe('isPasswordChangeRequired', () => {
  it('matches only a 403 carrying MUST_CHANGE_PASSWORD', () => {
    expect(isPasswordChangeRequired(axiosError(403, 'MUST_CHANGE_PASSWORD'))).toBe(true);
  });

  it('leaves every other failure to the generic states', () => {
    expect(isPasswordChangeRequired(axiosError(403, 'FORBIDDEN'))).toBe(false);
    expect(isPasswordChangeRequired(axiosError(401, 'MUST_CHANGE_PASSWORD'))).toBe(false);
    expect(isPasswordChangeRequired(axiosError(404))).toBe(false);
    expect(isPasswordChangeRequired(new Error('Network Error'))).toBe(false);
    expect(isPasswordChangeRequired(null)).toBe(false);
    expect(isPasswordChangeRequired(undefined)).toBe(false);
  });
});

describe('isAdminSessionExpired', () => {
  it('matches only a 401 carrying SESSION_TIMEOUT', () => {
    expect(isAdminSessionExpired(axiosError(401, 'SESSION_TIMEOUT'))).toBe(true);
    expect(isAdminSessionExpired(axiosError(401))).toBe(false);
    expect(isAdminSessionExpired(axiosError(401, 'TOKEN_REVOKED'))).toBe(false);
    expect(isAdminSessionExpired(axiosError(403, 'SESSION_TIMEOUT'))).toBe(false);
    expect(isAdminSessionExpired(null)).toBe(false);
  });
});

describe('PasswordChangeRequiredNotice for an idled-out admin session', () => {
  it('asks the admin to sign in again and links to the admin login', () => {
    render(<PasswordChangeRequiredNotice reason="session" />);

    expect(screen.getByText(/admin session has expired/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /sign in again/i })).toHaveAttribute('href', '/admin/login');
    expect(screen.queryByText(/change your password/i)).not.toBeInTheDocument();
  });
});

describe('PasswordChangeRequiredNotice', () => {
  it('tells the admin what to do instead of offering a retry', () => {
    render(<PasswordChangeRequiredNotice />);

    expect(screen.getByText(/change your password in the admin area/i)).toBeInTheDocument();
    expect(screen.queryByText(/try again/i)).not.toBeInTheDocument();
  });

  it('links to the admin area, where the password-change dialog takes over', () => {
    render(<PasswordChangeRequiredNotice />);

    expect(screen.getByRole('link', { name: /go to admin area/i })).toHaveAttribute('href', '/admin');
  });
});
