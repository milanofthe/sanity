import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';

/**
 * Leave the web-only payloads out of the desktop build.
 *
 * `public` holds three things the app can never reach: the repositories the
 * web demo reads over HTTP, the fixtures the checks run against, and the
 * social preview image. Vite copies all of `public` into the bundle, so they
 * were being compiled into the executable: 40 MB of other people's
 * repositories in a 76 MB binary, which came down to 28 MB once they were
 * left out. Tauri sets `TAURI_ENV_PLATFORM` for the commands it runs, which is
 * how a build for the app is told apart from a build for the web.
 */
const WEB_ONLY = ['demo', 'fixture', 'fixture-self', 'fixture-pdf', 'og.png'];

function webOnlyPayloads() {
  return {
    name: 'sanity-web-only-payloads',
    closeBundle() {
      if (!process.env.TAURI_ENV_PLATFORM) return;
      for (const name of WEB_ONLY) rmSync(`dist/${name}`, { recursive: true, force: true });
    },
  };
}

/**
 * The visitor count for the website, whatsmytraffic's beacon.
 *
 * Only in a build for the web: the app is the same page, and a desktop app
 * has no business reporting to anyone, and the dev server is where the
 * checks run, which would count every run as a visit.
 */
const BEACON = {
  src: 'https://whatsmytraffic.com/beacon.js',
  websiteId: '97ec12ef-2519-4994-a39d-4075fc3a617d',
};

function webBeacon() {
  return {
    name: 'sanity-web-beacon',
    apply: 'build' as const,
    transformIndexHtml() {
      if (process.env.TAURI_ENV_PLATFORM) return [];
      return [
        {
          tag: 'script',
          attrs: { defer: true, src: BEACON.src, 'data-website-id': BEACON.websiteId },
          injectTo: 'body' as const,
        },
      ];
    },
  };
}

export default defineConfig({
  plugins: [svelte(), webOnlyPayloads(), webBeacon()],
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL('./src/lib', import.meta.url)),
    },
  },
  server: { port: 5183, strictPort: true },
  build: { target: 'esnext', outDir: 'dist' },
  clearScreen: false,
});
