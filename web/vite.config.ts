import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5183, strictPort: true },
  build: { target: 'esnext', outDir: 'dist' },
  clearScreen: false,
});
