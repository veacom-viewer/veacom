// The page: takes a dropped or chosen folder, files or ZIP, hands the File objects to the engine Worker,
// lists the series and draws the middle image of the first series. Nothing is uploaded anywhere.
//
// Files are untrusted. The server's Content-Security-Policy lets the page load only its own scripts and
// connect only to its own origin, and Trusted Types forbid turning text into HTML; text from files is
// only ever set with textContent. The engine runs in a Worker: if a file crashes it (a decoder fault or
// running out of WebAssembly memory), the Worker is replaced and the page keeps working.
// The page's `?threads=N` and `?hold=N` go to the Worker, which chooses the engine build by them.
const workerSettings = new URLSearchParams();
for (const name of ['threads', 'hold']) {
  const value = new URLSearchParams(location.search).get(name);
  if (value != null) workerSettings.set(name, String(Number(value)));
}
const workerURL = new URL(`./worker.js${workerSettings.size ? `?${workerSettings}` : ''}`, import.meta.url).href;
// Trusted Types: the only script URL the page may start is its own engine Worker.
const scripts = window.trustedTypes?.createPolicy('veacom-worker', {
  createScriptURL: (url) => {
    if (url !== workerURL) throw new TypeError('Only the engine Worker may be started');
    return url;
  },
});
let worker;
function startWorker() {
  worker?.terminate();
  worker = new Worker(scripts ? scripts.createScriptURL(workerURL) : workerURL, { type: 'module' });
  worker.onmessage = received;
  worker.onerror = () => failed('Görüntüleyici durdu.');
}
const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const view = $('view');

/** Every finished open, with its times in milliseconds (read by the measurement tools). */
window.__runs = [];
let current = null;

const ms = (value) => (value == null ? '–' : `${Math.round(value)} ms`);
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

function showTimes(run) {
  const lines = [
    `dosya listesi      ${ms(run.enumerated)}`,
    `seriler listelendi ${ms(run.listedPage)}  (motor ${ms(run.listed)}; ${run.listReads} okuma, ${mb(run.listBytes)}, ${ms(run.listReadMs)})`,
    ...(run.prefetch ? [`  önden okuma      ${ms(run.prefetched)}`] : []),
    `ilk görüntü        ${ms(run.framePage)}  (çözme ${ms(run.frame)})`,
    `küçük resimler     ${ms(run.thumbsPage)}  (${ms(run.thumbs)})`,
    `tüm seri (hacim)   ${ms(run.volume)}`,
    `wasm belleği       ${run.memory ? mb(run.memory) : '–'}`,
  ];
  if (run.extracted) lines.push(`ZIP'ten açılan     ${mb(run.extracted)}`);
  $('times').textContent = lines.join('\n');
  $('times').hidden = false;
}

// ?prefetch=1 (or window.__prefetch) reads the files' first 64 KiB in parallel before the engine starts.
const prefetchDefault = new URLSearchParams(location.search).get('prefetch') === '1';
// ?checksum=1: after the timings, a SHA-1 of every decoded series (to compare transfer syntaxes).
const checksum = new URLSearchParams(location.search).get('checksum') === '1';

function finish(run) {
  showTimes(run);
  const { resolve, start, ...result } = run;
  window.__runs.push(result);
  if (current === run) current = null;
  resolve(result);
}

// The engine stopped (crashed, hung or cannot load): a fresh one takes its place; the open study is lost.
function failed(message) {
  startWorker();
  $('status').textContent = message;
  if (current) {
    current.error = message;
    finish(current);
  }
}

function open(files, roots, { enumerated = null, volume = true, prefetch = window.__prefetch ?? prefetchDefault } = {}) {
  // Opening new files while the engine is still busy stops it, so a file that hangs it cannot block the page.
  if (current) failed('Önceki dosyalar bırakıldı.');
  $('series').replaceChildren();
  $('times').hidden = true;
  $('status').textContent = `${files.length} dosya okunuyor…`;
  const run = { files: files.length, roots, enumerated, prefetch, start: performance.now() };
  current = run;
  return new Promise((resolve) => {
    run.resolve = resolve;
    worker.postMessage({ type: 'open', files, roots, volume, prefetch, checksum });
  });
}

// Text from files goes in as text, never as HTML.
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Thumbnails in rows of three (two on narrow screens), the image count in a corner.
function showSeries(series) {
  $('series').replaceChildren(
    ...series.map((s, index) => {
      const tile = element('li', index === 0 ? 'tile selected' : 'tile');
      tile.title = `${s.description} (${s.modality})`;
      const thumb = element('div', 'thumb');
      thumb.append(element('canvas'), element('span', 'count', String(s.images)));
      tile.append(thumb, element('div', 'name', s.description || s.modality));
      tile.addEventListener('click', () => {
        for (const other of $('series').children) other.classList.toggle('selected', other === tile);
        worker.postMessage({ type: 'show', series: index });
      });
      return tile;
    }),
  );
}

function drawFrame({ width, height, rgba }) {
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer), width, height), 0, 0);
  canvas.hidden = false;
  $('hint').hidden = true;
}

function received({ data }) {
  const run = current;
  if (data.type === 'error' && data.fatal) {
    if (run) run.crash = `${data.message} ${data.detail ?? ''}`.trim();
    failed('Dosyalar okunamadı.');
    return;
  }
  if (data.type === 'frame') {
    drawFrame(data);
    if (run && data.frame != null) {
      run.frame = data.frame;
      run.framePage = performance.now() - run.start;
    }
    return;
  }
  if (!run) return;
  const now = performance.now() - run.start;
  if (data.type === 'listed') {
    Object.assign(run, { listed: data.listed, listedPage: now, listReads: data.listReads, listBytes: data.listBytes, listReadMs: data.listReadMs, prefetched: data.prefetched, extracted: data.extracted });
    run.series = data.series.map((s) => `${s.description}·${s.images}`);
    showSeries(data.series);
    $('status').textContent = `${data.series.length} seri`;
  } else if (data.type === 'thumb') {
    const tile = $('series').children[data.series];
    if (tile && data.bitmap) {
      const thumb = tile.querySelector('canvas');
      thumb.width = data.bitmap.width;
      thumb.height = data.bitmap.height;
      thumb.getContext('bitmaprenderer').transferFromImageBitmap(data.bitmap);
    }
  } else if (data.type === 'thumbs') {
    run.thumbs = data.thumbs;
    run.thumbsPage = now;
  } else if (data.type === 'volume') {
    run.volume = data.volume;
  } else if (data.type === 'checksums') {
    run.checksums = data.checksums;
  } else if (data.type === 'done' || data.type === 'error') {
    if (data.type === 'error') {
      run.error = data.message;
      $('status').textContent = data.message;
    }
    run.memory = data.memory;
    run.threads = data.threads;
    finish(run);
    // WebAssembly memory never shrinks: after files that were refused (a ZIP bomb stopped at its
    // limit, say), a fresh engine gives the memory back.
    if (data.type === 'error') startWorker();
  }
}
startWorker();

// Folder chooser: every file carries its path inside the chosen folder.
$('pick-folder').addEventListener('change', (event) => {
  const files = [...event.target.files].map((file) => ({ path: file.webkitRelativePath || file.name, file }));
  const roots = [...new Set(files.map((f) => f.path.split('/')[0]))];
  event.target.value = '';
  if (files.length) open(files, roots);
});

// File chooser: loose files or a ZIP. The measurement tool sets their folder paths beforehand.
$('pick-files').addEventListener('change', (event) => {
  const chosen = [...event.target.files];
  const paths = window.__relpaths;
  const files = chosen.map((file, i) => ({ path: paths?.[i] ?? file.name, file }));
  const roots = window.__roots ?? files.map((f) => f.path);
  window.__relpaths = window.__roots = undefined;
  event.target.value = '';
  if (files.some((f) => f.path.split('/').pop() !== f.file.name)) {
    $('status').textContent = 'Dosya yolları dosyalarla eşleşmiyor.';
    window.__runs.push({ error: 'paths do not match the chosen files' });
    return;
  }
  if (files.length) open(files, roots);
});

// Drag and drop: folders are walked with the File and Directory Entries API (all current browsers).
async function dropped(items) {
  const entries = [...items].map((item) => item.webkitGetAsEntry()).filter(Boolean);
  const found = [];
  const walk = async (entry, path) => {
    if (entry.isFile) {
      found.push({ entry, path });
      return;
    }
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) break;
      await Promise.all(batch.map((child) => walk(child, `${path}/${child.name}`)));
    }
  };
  await Promise.all(entries.map((entry) => walk(entry, entry.name)));
  const files = await Promise.all(found.map(({ entry, path }) => new Promise((resolve, reject) => entry.file((file) => resolve({ path, file }), reject))));
  return { files, roots: entries.map((entry) => entry.name) };
}

view.addEventListener('dragover', (event) => {
  event.preventDefault();
  view.classList.add('over');
});
view.addEventListener('dragleave', () => view.classList.remove('over'));
view.addEventListener('drop', async (event) => {
  event.preventDefault();
  view.classList.remove('over');
  const start = performance.now();
  const { files, roots } = await dropped(event.dataTransfer.items);
  if (files.length) open(files, roots, { enumerated: performance.now() - start });
});

// Development only: ?test=petct|bigct|calisma&rounds=N opens one of the synthetic test studies served
// by serve.mjs. The files are fetched into memory first; that time is not counted.
const params = new URLSearchParams(location.search);
if (params.has('test')) {
  const name = params.get('test');
  const rounds = Number(params.get('rounds') ?? 1);
  (async () => {
    $('status').textContent = 'Deneme verisi indiriliyor…';
    const list = await (await fetch(`/__testdata/${name}/__list`)).json();
    const files = await Promise.all(
      list.files.map(async (path) => ({ path, file: new File([await (await fetch(`/__testdata/${name}/${path.split('/').map(encodeURIComponent).join('/')}`)).blob()], path.split('/').pop()) })),
    );
    for (let i = 0; i < rounds; i++) await open(files, list.roots);
  })();
}
window.veacomOpen = open;
