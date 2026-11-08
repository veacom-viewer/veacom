// viewer.veacom.app: the browser build of VEAcom, served from ./public (made by prepare.mjs) with the headers it needs.
// The files a user opens never reach this Worker: the page reads them on the user's computer. The Worker only hands
// out the site's own files, and only for reading.

const HEADERS = {
  // Cross-origin isolation: SharedArrayBuffer, so the engine can decode on several threads.
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), bluetooth=()',
  'Strict-Transport-Security': 'max-age=31536000',
};

/** Opened files are untrusted. The page and its Workers may run only the site's own built scripts (under /assets/, so
 * not even Cloudflare's own scripts under /cdn-cgi/) and its WebAssembly, may connect only to the site itself, and may
 * not turn text into HTML or script (Trusted Types; the one policy, `default`, is in src/web/trusted-types.ts). */
function contentPolicy(origin) {
  return [
    "default-src 'none'",
    `script-src ${origin}/assets/ 'wasm-unsafe-eval'`,
    `worker-src ${origin}/assets/`,
    "connect-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    "img-src 'self' blob: data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "require-trusted-types-for 'script'",
    'trusted-types default',
  ].join('; ');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Over plain HTTP the page cannot work (no secure context) and could be changed on the way: always HTTPS. Cloudflare
    // says how the visitor came; wrangler dev on this computer says nothing and is left alone.
    const visitor = request.headers.get('X-Forwarded-Proto') ?? (/"scheme":"(\w+)"/.exec(request.headers.get('CF-Visitor') ?? '')?.[1]);
    if (url.protocol === 'http:' && visitor === 'http') {
      url.protocol = 'https:';
      return new Response(null, { status: 301, headers: { ...HEADERS, Location: url.href } });
    }
    const policy = { ...HEADERS, 'Content-Security-Policy': contentPolicy(url.origin) };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { ...policy, Allow: 'GET, HEAD' } });
    }
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(policy)) headers.set(name, value);
    // Names under /assets/ change with their content, so the browser keeps those files and never asks again (the
    // engine, about 4.5 MB, among them). Anything else is checked on every visit, so a new version reaches everyone.
    // The page also says no-transform: otherwise Cloudflare adds its analytics script to it (a setting of the whole
    // veacom.app zone). The content policy blocks that script anyway, but the page should arrive as it was built.
    // Only the page: no-transform would also stop Cloudflare compressing the engine. A 304 for an asset keeps the long
    // caching too, or one revalidation would undo it.
    const page = (headers.get('Content-Type') ?? '').startsWith('text/html');
    const kept = url.pathname.startsWith('/assets/') && (response.ok || response.status === 304);
    headers.set('Cache-Control', kept ? 'public, max-age=31536000, immutable' : page ? 'no-cache, no-transform' : 'no-cache');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};
