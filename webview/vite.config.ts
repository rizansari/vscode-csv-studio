import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { defineConfig } from 'vite';

// Builds a single index.js + index.css that the extension loads into the webview.
export default defineConfig({
  root: resolve(__dirname),
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, '../dist/webview'),
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: false,
    rollupOptions: {
      input: { index: resolve(__dirname, 'src/main.tsx') },
      output: { entryFileNames: '[name].js', chunkFileNames: '[name].js', assetFileNames: (asset) => (asset.names.some((n) => n.endsWith('.css')) ? 'index.css' : '[name][extname]') },
    },
  },
});
