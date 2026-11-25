import { defineConfig, type Plugin } from 'vite';
import { onnxRuntime, reactCompiler } from './vite.config';

/** Fetch the reading interface while its browser bridge starts. The bridge still controls when the interface runs. */
function preloadReader(): Plugin {
  return { name: 'preload-reader', apply: 'build', transformIndexHtml: {
    order: 'post',
    handler(_html, { bundle }) {
      for (const item of Object.values(bundle ?? {})) {
        if (item.type !== 'chunk' || !item.facadeModuleId?.endsWith('/src/main.tsx')) continue;
        return [
          { tag: 'link', attrs: { rel: 'modulepreload', crossorigin: true, href: './' + item.fileName } },
          ...Array.from(item.viteMetadata?.importedCss ?? [], file => ({
            tag: 'link', attrs: { rel: 'preload', as: 'style', crossorigin: true, href: './' + file },
          })),
        ];
      }
    },
  } };
}

// The browser build (viewer.veacom.app): web.html runs the same application with its engine in a Web Worker
// (src/web), compiled to WebAssembly by web/build.ps1 first. Built apart from the desktop's pages, so neither
// carries the other's code: `pnpm run build:browser`, then web/site/prepare.mjs makes the site's files.
export default defineConfig({
  plugins: [reactCompiler(), preloadReader()],
  resolve: { alias: [onnxRuntime] },
  base: './', server: { host: '127.0.0.1', port: 5174, strictPort: true },
  // The bundled packages' licences go with the site, as the desktop build's go with the app (Help links to them).
  build: { outDir: 'dist-web', target: 'es2022', license: { fileName: 'THIRD_PARTY_JAVASCRIPT_LICENSES.md' }, modulePreload: { polyfill: false },
    rolldownOptions: { input: { web: 'web.html' } } },
  // The engine Worker loads one of two engine builds when it starts: module Workers allow that.
  worker: { format: 'es' },
});
