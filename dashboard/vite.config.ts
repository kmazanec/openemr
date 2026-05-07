import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The SPA is served at /dashboard/ in production (Apache rewrites
// /dashboard/* → dashboard/dist/index.html). Setting `base` here
// makes Vite emit asset paths under /dashboard/ so the same bundle
// works in dev under Vite (root /) and in prod under Apache.
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE ?? '/',
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
