/// <reference types="vitest" />
// @ts-nocheck

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import type { UserConfig as VitestUserConfig } from 'vitest/config'

// The backend the dev server proxies to (npm run dev in backend/).
const DEV_BACKEND = 'http://localhost:3001'

// https://vite.dev/config/
const config: VitestUserConfig = {
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'ui-vendor': ['lucide-react', 'react-toastify'],
          // Migration 137 — admin calendar deps (~200 KB). Carved into
          // their own chunk so the main bundle isn't penalised on
          // every page load; the calendar route lazy-loads this chunk
          // on demand via React.lazy.
          'fullcalendar': [
            '@fullcalendar/react',
            '@fullcalendar/core',
            '@fullcalendar/daygrid',
            '@fullcalendar/timegrid',
            '@fullcalendar/interaction',
          ],
        },
      },
    },
    sourcemap: false,
  },
  test: {
    environment: 'jsdom',
    setupFiles: './vitest.setup.ts',
    globals: true
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': {
        target: DEV_BACKEND,
        changeOrigin: true,
      },
      '/photos': {
        target: DEV_BACKEND,
        changeOrigin: true,
      },
      '/uploads': {
        target: DEV_BACKEND,
        changeOrigin: true,
      },
      // Website builder (issue 2618): the preview's and the pages' images,
      // their fonts, and the sitemap come from the backend.
      '/site-media': {
        target: DEV_BACKEND,
        changeOrigin: true,
      },
      '/fonts': {
        target: DEV_BACKEND,
        changeOrigin: true,
      },
      '/sitemap.xml': {
        target: DEV_BACKEND,
        changeOrigin: true,
      },
    },
  }
}

// The dev server answers / and the website's page slugs with this app, so
// the builder's "Open site" goes to the backend instead (issue 2618). Only
// the dev server: a build, and the tests, never carry it.
export default defineConfig(({ command, mode }) => ({
  ...config,
  ...(command === 'serve' && mode !== 'test'
    ? { define: { __PICPEAK_DEV_SITE_ORIGIN__: JSON.stringify(DEV_BACKEND) } }
    : {}),
}) as any)
