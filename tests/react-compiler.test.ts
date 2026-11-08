import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
