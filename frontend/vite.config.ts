/// <reference types="vitest" />
// @ts-nocheck

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import type { UserConfig as VitestUserConfig } from 'vitest/config'

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
        target: 'http://localhost:7101',
        changeOrigin: true,
      },
      '/photos': {
        target: 'http://localhost:7101',
        changeOrigin: true,
      },
      '/uploads': {
        target: 'http://localhost:7101',
        changeOrigin: true,
      },
    },
  }
}

export default defineConfig(config as any)
