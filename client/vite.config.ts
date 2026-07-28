import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Proxying keeps the browser on a single origin during development, so the
    // frontend never needs to know the API's host or deal with CORS.
    proxy: {
      '/api': {
        target: 'http://localhost:4400',
        changeOrigin: true,
      },
    },
  },
});
