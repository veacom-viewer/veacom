import { defineConfig } from 'vite';
import { reactCompiler } from './vite.config';

// The browser build (viewer.veacom.app): web.html runs the same application with its engine in a Web Worker
// (src/web), compiled to WebAssembly by web/build.ps1 first. Built apart from the desktop's pages, so neither
// carries the other's code: `pnpm run build:browser`, then web/site/prepare.mjs makes the site's files.
export default defineConfig({
  plugins: [reactCompiler()],
  base: './', server: { host: '127.0.0.1', port: 5174, strictPort: true },
  build: { outDir: 'dist-web', target: 'es2022', modulePreload: { polyfill: false }, rolldownOptions: { input: { web: 'web.html' } } },
  // The engine Worker loads one of two engine builds when it starts: module Workers allow that.
  worker: { format: 'es' },
});
