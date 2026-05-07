import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The SPA is served at /dashboard/ in production (Apache rewrites
// /dashboard/* → dashboard/dist/index.html, with /dashboard/assets/*
// internally mapped to /dashboard/dist/assets/*). Setting `base`
// here makes Vite emit asset URLs under /dashboard/ so the prod
// bundle's <script src> resolves correctly.
//
// Override with VITE_BASE=/ for `npm run dev` if you want to mount
// the SPA at the root in the Vite dev server (default for the
// dev-stub flow used by Playwright).
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE ?? '/dashboard/',
  build: {
    outDir: 'dist',
    manifest: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
