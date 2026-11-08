import path from 'node:path';
import { transform } from 'oxc-transform-react';
import { createFilter, defineConfig, type Plugin } from 'vite';

const isRendererSource = createFilter('src/**/*.{js,jsx,ts,tsx}', 'src/import-window/**', { resolve: import.meta.dirname });

/** The React Compiler on the renderer's source (the browser build's too, vite.web.config.ts). The import page is
 * privileged, so React compilation belongs in the renderer's module transform. */
export function reactCompiler(): Plugin {
  return {
    name: 'veacom-react-compiler',
    enforce: 'pre',
    transform: {
      filter: { id: /\.[jt]sx?$/ },
      async handler(source, id) {
        if (!isRendererSource(id)) return;
        const result = await transform(id, source, { jsx: 'preserve', sourcemap: true, reactCompiler: { target: '19' } });
        if (result.fatal) this.error(result.errors.map(error => error.codeframe || error.message).join('\n'));
        return { code: result.code, map: result.map };
      },
    },
  };
}

// The import window runs where the application page cannot reach it (electron/import-view.cjs). That only holds if
// no package code reaches its page: the build fails if its chunks hold anything but this repository's own source.
function importWindowFirstParty(): Plugin {
  const root = import.meta.dirname;
  // Module ids come with forward slashes on every system, Windows included: compare in that form.
  const slashes = (value: string) => value.replaceAll('\\', '/');
  const page = slashes(path.join(root, 'import.html')), source = `${slashes(path.join(root, 'src'))}/`;
  const allowed = (id: string) => slashes(id) === page || slashes(id).startsWith(source);
  return {
    name: 'veacom-import-window-first-party',
    apply: 'build',
    generateBundle(_options, bundle) {
      const chunks = new Map(Object.values(bundle).flatMap(item => item.type === 'chunk' ? [[item.fileName, item] as const] : []));
      const entry = [...chunks.values()].find(chunk => chunk.isEntry && chunk.name === 'import');
      if (!entry) this.error('The import window has no entry chunk.');
      const queue = [entry], seen = new Set<string>();
      while (queue.length) {
        const chunk = queue.pop()!;
        if (seen.has(chunk.fileName)) continue;
        seen.add(chunk.fileName);
        if (process.env.VEACOM_PROBE) console.log('IMPORT-CHUNK', chunk.fileName, JSON.stringify(chunk.moduleIds));
        const foreign = chunk.moduleIds.filter(id => !allowed(id));
        if (foreign.length && !process.env.VEACOM_PROBE) this.error(`The import window's ${chunk.fileName} holds code from outside src/: ${foreign.join(', ')}`);
        for (const file of [...chunk.imports, ...chunk.dynamicImports]) { const next = chunks.get(file); if (next) queue.push(next); }
      }
    },
  };
}

export default defineConfig({
  plugins: [reactCompiler(), importWindowFirstParty()],
  base: './', server: { host: '127.0.0.1', port: 5173, strictPort: true },
  // Electron's Chromium preloads modules itself: no polyfill code in either page.
  build: {
    target: 'es2022',
    license: { fileName: 'THIRD_PARTY_JAVASCRIPT_LICENSES.md' },
    modulePreload: { polyfill: false },
    rolldownOptions: { input: { main: 'index.html', import: 'import.html' } },
  },
});
