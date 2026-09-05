/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  // GitHub Pages serves a project site from /<repo-name>/, not from the root,
  // so every asset URL needs that prefix or the page loads blank with 404s in
  // the console. Local dev and the Node console both serve from the root, so
  // this stays "/" unless the Pages workflow explicitly sets VITE_BASE.
  base: process.env.VITE_BASE || '/',
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        // Recharts is code-split by the lazy import in App.tsx, so it never
        // reaches the entry chunk. Only React is pinned here, because every
        // screen needs it and it should be cached across deploys.
        manualChunks: {
          react: ['react', 'react-dom'],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/__tests__/setup.ts',
    globals: true,
  },
})
