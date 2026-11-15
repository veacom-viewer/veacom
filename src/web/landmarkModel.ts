// The landmark model's graphs in the browser build (docs/landmark-model.md). This site serves them beside the page
// (web/site/prepare.mjs puts them under models/); each is checked against its size and SHA-256 before Cache Storage
// keeps it, so a later visit downloads nothing. The graphs of an earlier model are dropped from the cache.
// src/ui/landmarkSuggestions.ts checks them again before use. No Subresource Integrity: with it, fetch() gives nothing
// until the whole file has arrived, so the download could show no progress.
import manifest from '../../electron/landmark-model.json';

type Part = keyof typeof manifest.files;
const CACHE = 'veacom-landmark-model';
let controller = new AbortController();

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');

export async function landmarkModel(part: Part, onProgress?: (received: number) => void,
  { fetchImpl = fetch, store = globalThis.caches as CacheStorage | undefined, base = location.href } = {}): Promise<ArrayBuffer> {
  if (!Object.hasOwn(manifest.files, part)) throw new Error('Unknown model file.');
  const entry = manifest.files[part], url = new URL(`models/${entry.file}`, base).href;
  const wanted = new Set(Object.values(manifest.files).map(file => new URL(`models/${file.file}`, base).href));
  // Cache Storage exists only in a secure context, and a browser may refuse it (private windows): then it downloads.
  const cache = await store?.open(CACHE).catch(() => undefined);
  if (cache) for (const request of await cache.keys()) if (!wanted.has(request.url)) await cache.delete(request);
  const hit = await cache?.match(url);
  if (hit) {
    const bytes = await hit.arrayBuffer();
    if (bytes.byteLength === entry.bytes && hex(await crypto.subtle.digest('SHA-256', bytes)) === entry.sha256) return bytes;
    await cache!.delete(url);
  }
  const response = await fetchImpl(url, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
  if (!response.ok || !response.body) throw new Error(`The model file was not served (HTTP ${response.status}).`);
  const bytes = new Uint8Array(entry.bytes), reader = response.body.getReader();
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (received + value.length > entry.bytes) { await reader.cancel(); throw new Error('The model file is larger than expected.'); }
    bytes.set(value, received); received += value.length;
    onProgress?.(received);
  }
  if (received !== entry.bytes) throw new Error('The model file is incomplete.');
  if (hex(await crypto.subtle.digest('SHA-256', bytes)) !== entry.sha256) throw new Error('checksum');
  // A cache that refuses the file (its quota, private browsing) costs only a download next time: the checked bytes are used now.
  await cache?.put(url, new Response(bytes.slice(0), { headers: { 'Content-Type': 'application/octet-stream' } })).catch(() => {});
  return bytes.buffer;
}

/** Stops the downloads under way; the next request starts again. */
export function cancelLandmarkModel(): void { controller.abort(); controller = new AbortController(); }
