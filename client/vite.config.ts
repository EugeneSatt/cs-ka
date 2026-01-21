import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    fs: {
      allow: [resolve(__dirname, '..')],
    },
  },
});
