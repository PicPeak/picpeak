import React from 'react';
import ReCAPTCHA from 'react-google-recaptcha';
import { usePublicSettings } from '../../hooks/usePublicSettings';

interface ReCaptchaProps {
  onChange: (token: string | null) => void;
  onExpired?: () => void;
  size?: 'normal' | 'compact';
}

export const ReCaptcha: React.FC<ReCaptchaProps> = ({
  onChange,
  onExpired,
  size = 'normal'
}) => {
  const recaptchaRef = React.useRef<ReCAPTCHA>(null);
  const { data: settings } = usePublicSettings();

  const siteKey = settings?.recaptcha_site_key ?? '';

  if (!settings?.enable_recaptcha || !siteKey) {
    return null;
  }

  return (
    <div className="flex justify-center">
      <ReCAPTCHA
        ref={recaptchaRef}
        sitekey={siteKey}
        onChange={onChange}
        onExpired={onExpired}
        size={size}
        theme="light"
      />
    </div>
  );
};

export default ReCaptcha;
