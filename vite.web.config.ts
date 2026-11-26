import { createHash } from 'node:crypto';
import { build, defineConfig, type Plugin } from 'vite';
import { onnxRuntime, reactCompiler } from './vite.config';

/** Install the drop listener before the parser creates the page body, while the reader bundle is still loading. */
function captureDropsBeforeTheReader(): Plugin {
  let filename: string;
  return {
    name: 'capture-file-drops',
    apply: 'build',
    async buildStart() {
      const built = await build({
        configFile: false, publicDir: false, logLevel: 'warn',
        build: { write: false, target: 'es2022', lib: { entry: 'src/web/startupDrop.ts', formats: ['iife'], name: 'veacomStartupDrop' } },
      });
      const output = Array.isArray(built) ? built[0] : built;
      if (!('output' in output) || output.output[0]?.type !== 'chunk') throw new Error('The browser drop listener did not build.');
      const source = output.output[0].code;
      const hash = createHash('sha256').update(source).digest('hex').slice(0, 16);
      filename = 'assets/startup-drop-' + hash + '.js';
      this.emitFile({ type: 'asset', fileName: filename, source });
    },
    transformIndexHtml: {
      order: 'post',
      handler: () => [{ tag: 'script', attrs: { src: './' + filename }, injectTo: 'head-prepend' }],
    },
  };
}

// The browser build (viewer.veacom.app): web.html runs the same application with its engine in a Web Worker
// (src/web), compiled to WebAssembly by web/build.ps1 first. Built apart from the desktop's pages, so neither
// carries the other's code: `pnpm run build:browser`, then web/site/prepare.mjs makes the site's files.
export default defineConfig({
  plugins: [reactCompiler(), captureDropsBeforeTheReader()],
  resolve: { alias: [onnxRuntime] },
  base: './', server: { host: '127.0.0.1', port: 5174, strictPort: true },
  // The bundled packages' licences go with the site, as the desktop build's go with the app (Help links to them).
  build: { outDir: 'dist-web', target: 'es2022', license: { fileName: 'THIRD_PARTY_JAVASCRIPT_LICENSES.md' }, modulePreload: { polyfill: false },
    rolldownOptions: { input: { web: 'web.html' } } },
  // The engine Worker loads one of two engine builds when it starts: module Workers allow that.
  worker: { format: 'es' },
});
