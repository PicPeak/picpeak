import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../config/api';
import { Button } from '../../components/common/Button';
import { checkoutBrowserKey } from './checkoutBrowserKey';

export interface PromoAccess { grant: string; expiresAt: number }
const storageKey = (slug: string) => `picpeak_photo_promo_${slug}`;

export function clearPromoAccess(slug: string): void {
  try { sessionStorage.removeItem(storageKey(slug)); } catch { /* Storage may be disabled. */ }
}
export function readPromoAccess(slug: string): PromoAccess | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey(slug)) || 'null');
    if (typeof value?.grant === 'string' && Number.isFinite(value.expiresAt) && value.expiresAt > Date.now()) return value;
  } catch { /* The cart still works without storage. */ }
  clearPromoAccess(slug);
  return null;
}
export function savePromoAccess(slug: string, access: PromoAccess): void {
  try { sessionStorage.setItem(storageKey(slug), JSON.stringify(access)); } catch { /* Caller keeps it in state. */ }
}

interface PendingCode { challenge: string; expiresAt: number; resendAt: number }
const challengeKey = (slug: string) => `picpeak_photo_promo_code_${slug}`;
function pendingCode(slug: string): PendingCode | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(challengeKey(slug)) || 'null');
    if (/^[0-9a-f]{48}$/.test(value?.challenge || '') && Number.isFinite(value.expiresAt)
        && value.expiresAt > Date.now() && Number.isFinite(value.resendAt)) return value;
  } catch { /* Optional persistence for reloads and closing the cart. */ }
  return null;
}

export function PromoVerification({ slug, promoCode, onVerified }: {
  slug: string; promoCode: string; onVerified: (access: PromoAccess) => void;
}) {
  const { t, i18n } = useTranslation();
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState<PendingCode | null>(() => pendingCode(slug));
  const challenge = pending?.challenge || '';
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'send' | 'confirm' | null>(null);
  const [wait, setWait] = useState(() => Math.max(0, Math.ceil(((pending?.resendAt || 0) - Date.now()) / 1000)));
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const errorText = useRef<HTMLParagraphElement>(null);
  const remember = (value: PendingCode | null) => {
    setPending(value);
    try {
      if (value) sessionStorage.setItem(challengeKey(slug), JSON.stringify(value));
      else sessionStorage.removeItem(challengeKey(slug));
    } catch { /* No email address or submitted code is persisted. */ }
  };
  useEffect(() => { if (challenge) input.current?.focus(); }, [challenge]);
  useEffect(() => { if (error) errorText.current?.scrollIntoView?.({ block: 'nearest' }); }, [error]);
  useEffect(() => {
    if (wait <= 0) return;
    const timer = window.setTimeout(() => setWait((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [wait]);
  const report = (caught: unknown) => {
    const body = (caught as { response?: { data?: { code?: string; retryAfterSeconds?: number } } })?.response?.data;
    if (body?.code === 'CHECKOUT_PROMO_RATE_LIMITED') setWait(Math.max(1, body.retryAfterSeconds || 60));
    const messages: Record<string, string> = {
      CHECKOUT_PROMO_EMAIL_INVALID: t('photoSales.promoEmailInvalid', 'Enter a valid email address.'),
      CHECKOUT_PROMO_CODE_INVALID: t('photoSales.promoCodeInvalid', 'The code is incorrect or has expired. Request a new code if needed.'),
      CHECKOUT_PROMO_RATE_LIMITED: t('photoSales.promoEmailLimited', 'Please wait before requesting another code.'),
      PROMO_UNAVAILABLE: t('photoSales.checkoutPromoUnavailable', 'This promo code is used or reserved by another checkout. Try again later or remove the code.'),
    };
    setError(messages[body?.code || ''] || t('photoSales.promoEmailUnavailable', 'We could not verify your email right now. Try again later, or remove the promo to continue without it.'));
  };
  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || wait) return;
    setBusy('send'); setError('');
    try {
      const response = await api.post<{ challenge: string; resendAfterSeconds: number }>(`/gallery/${encodeURIComponent(slug)}/checkout/promo-verification`, {
        email: email.trim(), promoCode, browserKey: checkoutBrowserKey(), language: i18n?.language || 'en',
      });
      remember({ challenge: response.data.challenge, expiresAt: Date.now() + 15 * 60e3, resendAt: Date.now() + response.data.resendAfterSeconds * 1000 });
      setCode(''); setWait(response.data.resendAfterSeconds);
    } catch (caught) { report(caught); }
    finally { setBusy(null); }
  };
  const confirm = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy('confirm'); setError('');
    try {
      const response = await api.post<{ grant: string; expiresInSeconds: number }>(`/gallery/${encodeURIComponent(slug)}/checkout/promo-verification/confirm`, {
        challenge, code, promoCode, browserKey: checkoutBrowserKey(),
      });
      remember(null);
      onVerified({ grant: response.data.grant, expiresAt: Date.now() + response.data.expiresInSeconds * 1000 });
    } catch (caught) { report(caught); }
    finally { setBusy(null); }
  };
  return <div className="mt-3 space-y-3 rounded-lg border border-line p-3 text-sm text-body">
    <p>{t('photoSales.promoVerifyHelp', 'Verify your email to use this promo. No account is needed. You can have one active promo checkout at a time across galleries.')}</p>
    <form onSubmit={send} className="space-y-2">
      <label className="block">{t('photoSales.promoEmail', 'Email for verification')}
        <input className="input mt-1 w-full" type="email" autoComplete="email" maxLength={255} required value={email} disabled={!!busy} onChange={(event) => {
          setEmail(event.target.value); remember(null); setCode(''); setError('');
        }} />
      </label>
      <Button type="submit" variant="secondary" isLoading={busy === 'send'} focusableWhileLoading disabled={busy === 'confirm' || wait > 0}>
        {wait > 0 ? t('photoSales.promoResendWait', 'Send another code in {{seconds}}s', { seconds: wait }) : t('photoSales.promoSendCode', 'Email me a code')}
      </Button>
    </form>
    {challenge && <form onSubmit={confirm} className="space-y-2">
      <p role="status">{t('photoSales.promoCodeSent', 'Code sent. Check your inbox and spam folder. It expires in 15 minutes.')}</p>
      <label className="block">{t('photoSales.promoEmailCode', '6-digit email code')}
        <input ref={input} className="input mt-1 w-full" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6} required value={code} disabled={!!busy} onChange={(event) => setCode(event.target.value)} />
      </label>
      <Button type="submit" variant="secondary" isLoading={busy === 'confirm'} focusableWhileLoading disabled={busy === 'send'}>{t('photoSales.promoVerifyCode', 'Verify email')}</Button>
    </form>}
    {error && <p ref={errorText} role="alert" className="text-danger">{error}</p>}
  </div>;
}
