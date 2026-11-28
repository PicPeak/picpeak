/// <reference types="vite/client" />
/// <reference types="vitest" />

// The backend origin, on the Vite dev server only (vite.config.ts).
declare const __PICPEAK_DEV_SITE_ORIGIN__: string | undefined;

// Swiper CSS module declarations
declare module 'swiper/css' {
  const content: string;
  export default content;
}

declare module 'swiper/css/free-mode' {
  const content: string;
  export default content;
}
