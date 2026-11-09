// An adapter for a viewer pinned in tools/browser-bench/viewers.json: serves its checked copy (or points at the live site) and
// carries what the runner needs to know about driving it. Each viewer's own file adds how to open a study, how to
// set window/level and anything to do once the page has loaded.
import { fileURLToPath } from 'node:url';
import { ensureViewer, liveBuild, lockEntry } from '../fetch-viewers.mjs';
import { serveStatic } from '../lib/serve.mjs';

export function pinned(name, adapter) {
  const entry = lockEntry(name);
  if (!entry) throw new Error(`${name} is not in tools/browser-bench/viewers.json`);
  return {
    name, version: entry.version, path: entry.serve.entry ?? '', live: Boolean(entry.serve.live),
    async serve() {
      if (entry.serve.live) {
        const live = await liveBuild(entry);
        return { url: entry.source.url, close: async () => {}, build: live.assets, pinned: live.pinned };
      }
      const root = await ensureViewer(entry, { log: () => {} });
      const overlay = Object.fromEntries(Object.entries(entry.serve.overlay ?? {}).map(([file, from]) => [file, fileURLToPath(new URL(`../${from}`, import.meta.url))]));
      return serveStatic(root, { spa: entry.serve.spa, isolation: entry.serve.isolation, overlay });
    },
    ...adapter,
  };
}
