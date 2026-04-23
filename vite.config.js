import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    open: true,
  },
  optimizeDeps: {
    exclude: ['pdfjs-dist'],
  },
});
