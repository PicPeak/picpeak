/**
 * Login-page logo sizing (#354 follow-up).
 *
 * Used ONLY on /admin/login and /customer/login. The rest of the app
 * (gallery headers, admin chrome) keeps its own `branding_logo_size` /
 * `branding_logo_max_height` knobs — kept separate so admins can have a
 * compact logo in the in-app header but a hero-sized one on the login
 * splash.
 *
 * Returns Tailwind class strings for both modes:
 *  - `frame`: dimensions of the tinted square frame + the inner image.
 *  - `bare`:  height/width of the standalone image when the frame is off.
 */
export type LoginLogoSize = 'small' | 'medium' | 'large' | 'xlarge';

interface LoginLogoClasses {
  frameOuter: string; // tinted square dimensions
  frameInner: string; // logo image inside the frame
  bare: string;       // logo image when frame is off
}

const SIZE_MAP: Record<LoginLogoSize, LoginLogoClasses> = {
  small: {
    frameOuter: 'w-[140px] h-[105px]',
    frameInner: 'w-[120px] h-[90px]',
    bare: 'h-16 w-auto',
  },
  medium: {
    // Matches the visual state shipped before the size toggle existed.
    frameOuter: 'w-[200px] h-[150px]',
    frameInner: 'w-[180px] h-[130px]',
    bare: 'h-24 w-auto',
  },
  large: {
    frameOuter: 'w-[260px] h-[195px]',
    frameInner: 'w-[240px] h-[175px]',
    bare: 'h-32 w-auto',
  },
  xlarge: {
    frameOuter: 'w-[320px] h-[240px]',
    frameInner: 'w-[300px] h-[220px]',
    bare: 'h-40 w-auto',
  },
};

export function resolveLoginLogoClasses(size: LoginLogoSize | string | undefined | null): LoginLogoClasses {
  if (size && size in SIZE_MAP) return SIZE_MAP[size as LoginLogoSize];
  return SIZE_MAP.medium;
}

export const LOGIN_LOGO_SIZES: LoginLogoSize[] = ['small', 'medium', 'large', 'xlarge'];
