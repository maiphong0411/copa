import { defineConfig } from 'vite'

// GitHub Pages serves a project site from https://<user>.github.io/<repo>/,
// so every asset URL needs that prefix baked in at build time. A user/org
// site (<user>.github.io) is served from the root and wants base: '/'.
export default defineConfig({
  base: process.env.PAGES_BASE ?? '/copa/',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
  },
  worker: {
    format: 'es',
  },
})
