import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** Packages that ship as one unit with React and version with it. */
const REACT_RUNTIME = new Set([
  'react',
  'react-dom',
  'react-is',
  'react-router',
  'react-router-dom',
  'scheduler',
]);

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
    rollupOptions: {
      output: {
        // Recharts and React change on their own release cadence, which is to
        // say almost never relative to this app. Splitting them out means a
        // redeploy invalidates the small application chunk and leaves the large
        // vendor one in the browser's cache, rather than shipping the whole
        // bundle again because a label was reworded.
        manualChunks(id: string): string | undefined {
          // Module ids are posix-normalised by the bundler, so splitting on the
          // separator is enough and avoids a path regex that only works on one
          // platform.
          const parts = id.split('node_modules/');
          if (parts.length < 2) return undefined;
          const pkg = parts[parts.length - 1]!.split('/')[0]!;

          // Recharts brings its own copy of the d3 modules it needs; they
          // belong beside it rather than stranded in the application chunk.
          if (pkg === 'recharts' || pkg.startsWith('d3-') || pkg === 'victory-vendor') {
            return 'charts';
          }
          if (REACT_RUNTIME.has(pkg)) return 'react';
          return undefined;
        },
      },
    },
  },
});
