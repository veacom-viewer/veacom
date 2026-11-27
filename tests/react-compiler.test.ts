import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createServer } from 'vite';

test('Vite compiles renderer components and hooks and keeps the import window free of React', { timeout: 120_000 }, async () => {
  const server = await createServer({
    server: { middlewareMode: true, ws: false, watch: null, preTransformRequests: false },
    optimizeDeps: { noDiscovery: true },
  });
  try {
    for (const file of ['/src/App.tsx', '/src/components/Viewport.tsx', '/src/components/VolumeView.tsx', '/src/imaging/usePetStudies.ts']) {
      const module = await server.transformRequest(file);
      assert.match(module?.code ?? '', /react[/_]compiler-runtime/, file);
      // The workspace itself is compiled whole: a construct the compiler cannot lower (a default parameter read from a
      // ref, say) leaves the component uncompiled without an error, and every pane then re-renders the series list.
      if (file === '/src/App.tsx') assert.match(module?.code ?? '', /function App\(\)\s*\{\s*const \$ = _c\(\d+\)/, 'App is memoized');
    }
    const importPage = await server.transformRequest('/src/import-window/main.ts');
    assert.ok(importPage);
    assert.doesNotMatch(importPage.code, /react[/_]compiler-runtime/);
    const html = await server.transformIndexHtml('/import.html', await readFile(new URL('../import.html', import.meta.url), 'utf8'));
    const scripts = Array.from(html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi), ([, attributes, body]) => {
      assert.equal(body.trim(), '', 'Unexpected inline script in the privileged import page');
      return /\bsrc=["']([^"']+)["']/i.exec(attributes)?.[1];
    });
    assert.deepEqual(scripts.filter(src => src !== '/@vite/client'), ['/src/import-window/main.ts']);
  } finally {
    await server.close();
  }
});

test('the compiler memoizes App itself, which a `finally` in any of its functions would stop', { timeout: 120_000 }, async () => {
  const { transform } = await import('oxc-transform-react');
  const file = new URL('../src/App.tsx', import.meta.url);
  const result = await transform(fileURLToPath(file), await readFile(file, 'utf8'), { jsx: 'preserve', reactCompiler: { target: '19' } });
  const app = result.code.slice(result.code.indexOf('export default function App'));
  assert.match(app.slice(0, 400), /_c\(\d+\)/, 'App keeps its memo cache: paging must not sort the series again (tools/check-interface.cjs).');
});
