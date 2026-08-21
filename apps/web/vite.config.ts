import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    // In dev the API runs on its own port, so proxy through Vite rather than
    // pointing the client at http://localhost:4000 directly. Same-origin
    // requests in dev keep the CORS configuration honest, and it mirrors what
    // nginx does in the container build.
    proxy: {
      '/api': {
        target: process.env.VITE_DEV_API_TARGET ?? 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
