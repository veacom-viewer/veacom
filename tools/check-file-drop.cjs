const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ignoreOutsideInput } = require('./lib/outside-input.cjs');
const { closeDesktop } = require('./lib/close-desktop.cjs');

const repo = path.resolve(__dirname, '..');
const options = {};
for (let index = 2; index < process.argv.length; index++) {
  const argument = process.argv[index];
  if (argument === '--help') {
    console.log('Usage: node tools/check-file-drop.cjs [--study FILE_OR_FOLDER] [--output DIRECTORY] [--app PACKAGED_EXECUTABLE]');
    process.exit(0);
  }
  const [flag, inline] = argument.split(/=(.*)/s);
  assert(['--study', '--output', '--app'].includes(flag), `Unknown argument: ${argument}`);
  options[flag.slice(2)] = inline ?? process.argv[++index];
  assert(options[flag.slice(2)], `Missing value for ${flag}`);
}
const study = path.resolve(options.study || path.join(repo, '..', 'work', 'bench-studies', 'studies', 'ct-small', 'S01', 'IM00001.dcm'));
const output = path.resolve(options.output || path.join(repo, '..', 'work', 'file-drop-proof'));
const checks = [], errors = [], imports = [], logs = [];
const normalize = value => process.platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value);

async function dicomFiles(directory, limit = 2) {
  const found = [];
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await dicomFiles(file, limit - found.length));
    else if (entry.isFile() && (/\.(dcm|dicom)$/i.test(entry.name) || /^IM\d/i.test(entry.name))) found.push(await fs.realpath(file));
    if (found.length >= limit) break;
  }
  return found;
}

async function main() {
  await fs.mkdir(output, { recursive: true });
  const stat = await fs.stat(study);
  const folder = await fs.realpath(stat.isDirectory() ? study : path.dirname(study));
  const candidates = await dicomFiles(folder);
  const first = stat.isDirectory() ? candidates[0] : await fs.realpath(study);
  const second = candidates.find(file => file !== first);
  assert(first && second, 'Use a DICOM fixture with at least two files in the selected folder.');
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'veacom-file-drop-'));
  let desktop, page, failure;
  try {
    const env = { ...process.env, VEACOM_USER_DATA: profile, VEACOM_TEST_MODE: '1' };
    delete env.VEACOM_DEV_URL;
    delete env.VEACOM_DEVTOOLS;
    desktop = await electron.launch({ ...(options.app ? { executablePath: path.resolve(options.app) } : {}), args: options.app ? [] : [repo], env, timeout: 90_000 });
    desktop.process().stderr?.on('data', data => logs.push(data.toString()));
    page = await desktop.firstWindow();
    // The drops below are DragEvents dispatched in the page, not dragged by the operating system, so the window can
    // ignore the computer's own mouse and keyboard, which would otherwise reach it.
    await ignoreOutsideInput(desktop);
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => document.querySelector('[data-testid="veacom-app"]')?.dataset.ready === 'true' && typeof window.veacom?.importFiles === 'function', undefined, { timeout: 90_000 });
    assert.equal(new URL(page.url()).protocol, 'veacom:', 'The test must load the production bundle, not Vite.');
    const preferences = await desktop.evaluate(({ BrowserWindow }) => {
      const values = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return { sandbox: values.sandbox, contextIsolation: values.contextIsolation, nodeIntegration: values.nodeIntegration };
    });
    assert.deepEqual(preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false });
    const importEvents = () => desktop.evaluate(({ app }) => app.__VEACOM_PRIVILEGED_TEST__.getImportEvents());
    const coreRequest = (op, body) => desktop.evaluate(({ app }, { op, body }) => app.__VEACOM_PRIVILEGED_TEST__.coreRequest(op, body), { op, body });
    const nativeSeries = async () => {
      const answer = await coreRequest('series');
      assert(answer.ok, 'Could not read native series state.');
      return answer.json.series;
    };
    assert.equal((await nativeSeries()).length, 0, 'Fresh test profile must start without an imported study.');

    const createInput = async (id, directory = false) => {
      await page.evaluate(({ id, directory }) => {
        document.getElementById(id)?.remove();
        const input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.id = id; input.hidden = true;
        if (directory) input.setAttribute('webkitdirectory', '');
        document.body.append(input);
      }, { id, directory });
      return page.locator(`#${id}`);
    };
    const fileCapabilities = id => page.evaluate(id => window.veacom.importFiles([...document.getElementById(id).files]), id);
    const fullImage = async (id, selector = '.viewport-cell.is-active') => {
      await page.waitForFunction(({ id, selector }) => {
        const cell = document.querySelector(selector), canvas = cell?.querySelector('canvas[data-renderer]');
        return cell?.dataset.volumeComplete === 'true' && cell.dataset.seriesId === id && canvas?.dataset.seriesId === id && canvas.width > 0 && canvas.height > 0;
      }, { id, selector }, { timeout: 60_000 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const pixels = await page.locator(`${selector} canvas[data-renderer]`).evaluate(async canvas => {
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let minimum = 255, maximum = 0;
        for (let index = 0; index < data.length; index += 4) {
          minimum = Math.min(minimum, data[index], data[index + 1], data[index + 2]);
          maximum = Math.max(maximum, data[index], data[index + 1], data[index + 2]);
        }
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(value => value.toString(16).padStart(2, '0')).join('');
        return { width: canvas.width, height: canvas.height, minimum, maximum, sha256: hash, renderer: canvas.dataset.renderer, seriesId: canvas.dataset.seriesId, slice: canvas.dataset.slice };
      });
      assert(pixels.maximum - pixels.minimum > 8, 'Expected a visible non-uniform DICOM image, not an empty canvas.');
      return pixels;
    };
    const drop = async (name, inputId, expectedPaths, target = '[data-testid="veacom-app"]', duplicateFirst = false) => {
      const capabilities = await fileCapabilities(inputId);
      assert.equal(capabilities.length, new Set(expectedPaths.map(normalize)).size);
      assert(capabilities.every(value => value.startsWith('import:')), 'The renderer must receive opaque capabilities.');
      const beforeImports = (await importEvents()).length;
      const gate = await desktop.evaluate(({ app }) => app.__VEACOM_PRIVILEGED_TEST__.holdPixelRequests('volume'));
      const events = await page.evaluate(({ inputId, target, duplicateFirst }) => {
        const input = document.getElementById(inputId), element = document.querySelector(target);
        if (!element || !input.files.length) throw new Error('Missing drop target or real input files.');
        const transfer = new DataTransfer();
        for (const file of input.files) transfer.items.add(file);
        if (duplicateFirst) transfer.items.add(input.files[0]);
        const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer });
        element.dispatchEvent(over);
        const dropped = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer });
        element.dispatchEvent(dropped);
        return { fileCount: transfer.files.length, types: [...transfer.types], dragoverPrevented: over.defaultPrevented, dropPrevented: dropped.defaultPrevented };
      }, { inputId, target, duplicateFirst });
      assert(events.types.includes('Files') && events.dragoverPrevented && events.dropPrevented, 'External drop was not accepted.');
      await desktop.evaluate(({ app }, gate) => app.__VEACOM_PRIVILEGED_TEST__.waitForHeldPixelRequest(gate), gate);
      const recorded = await importEvents();
      const imported = recorded.at(-1).result;
      imports.splice(0, imports.length, ...recorded.map(event => event.paths));
      assert(imported.series.length, 'Drop did not import a DICOM series.');
      await desktop.evaluate(({ app }, gate) => app.__VEACOM_PRIVILEGED_TEST__.releasePixelRequests(gate), gate);
      const decoded = await coreRequest('volume', { id: imported.series[0].id });
      assert(decoded.ok, 'The imported volume did not decode.');
      const decodedBytes = decoded.byteLength;
      assert(decodedBytes > 0, 'Volume response had no pixel data.');
      const chosen = imported.series[0];
      const image = await fullImage(chosen.id);
      const native = (await nativeSeries()).find(item => item.id === chosen.id);
      assert(native, 'Imported series missing from the native engine.');
      assert.deepEqual(native.dimensions, chosen.dimensions);
      // The pane's slice bar (src/components/SliceBar.tsx) counts slices from 1.
      const range = await page.locator('.viewport-cell.is-active [role="slider"][data-action="slice-slider"]').getAttribute('aria-valuemax');
      assert.equal(Number(range), chosen.dimensions[2], 'Displayed full-volume slice count does not match native metadata.');
      assert.equal(imports.length, beforeImports + 1, 'A single drop should trigger exactly one import.');
      assert.deepEqual(imports.at(-1).map(normalize), [...new Set(expectedPaths.map(normalize))], 'Paths were not deduplicated before native import.');
      await page.screenshot({ path: path.join(output, `${name}.png`) });
      const detail = { name, passed: true, capabilities, events, importPaths: imports.at(-1), native: { id: native.id, dimensions: native.dimensions, modality: native.modality }, decodedBytes, image };
      checks.push(detail); console.log(`PASS ${name}`);
      return chosen;
    };

    const input = await createInput('veacom-drop-files');
    await input.setInputFiles(first);
    await drop('file-on-app', 'veacom-drop-files', [first]);
    await input.setInputFiles(second);
    await drop('file-on-existing-viewport', 'veacom-drop-files', [second], '.dicom-viewport');
    await input.setInputFiles([first, second]);
    await drop('multiple-files-deduplicated', 'veacom-drop-files', [first, second], '.dicom-viewport', true);

    let folderMode = 'raw-directory-file', rawDirectoryUnavailable;
    await createInput('veacom-drop-folder');
    const cdp = await page.context().newCDPSession(page);
    try {
      const document = await cdp.send('DOM.getDocument');
      const node = await cdp.send('DOM.querySelector', { nodeId: document.root.nodeId, selector: '#veacom-drop-folder' });
      await cdp.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [folder] });
      assert.deepEqual(await page.evaluate(() => [...document.getElementById('veacom-drop-folder').files].map(file => file.name)), [path.basename(folder)]);
    } catch (error) {
      folderMode = 'webkitdirectory-contents'; rawDirectoryUnavailable = error.message;
      const directoryInput = await createInput('veacom-drop-folder', true);
      await directoryInput.setInputFiles(folder);
    } finally { await cdp.detach(); }
    const folderPaths = folderMode === 'raw-directory-file' ? [folder] : await dicomFiles(folder, Infinity);
    assert(folderPaths.length, 'Directory picker did not supply disk-backed files.');
    const folderSeries = await drop('folder-on-viewport', 'veacom-drop-folder', folderPaths, '.dicom-viewport');
    Object.assign(checks.at(-1), { folderMode, rawDirectoryUnavailable });

    await page.getByTestId('tool-layout').click();
    await page.locator('[data-layout="1x2"]').click();
    await page.locator('[data-testid="viewport-cell"]').nth(1).waitFor();
    assert.equal(await page.locator('[data-testid="viewport-cell"]').nth(1).getAttribute('data-series-id'), '');
    const beforeInternal = imports.length;
    const internal = await page.evaluate(id => {
      const card = document.querySelector(`[data-testid="series-${id}"]`), target = document.querySelectorAll('[data-testid="viewport-cell"]')[1];
      const transfer = new DataTransfer();
      card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      card.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
      return { id: transfer.getData('application/x-veacom-series'), types: [...transfer.types], files: transfer.files.length };
    }, folderSeries.id);
    assert.equal(internal.id, folderSeries.id);
    assert.equal(internal.files, 0);
    const image = await fullImage(folderSeries.id, '[data-testid="viewport-cell"]:nth-child(2)');
    assert.equal((await importEvents()).length, beforeInternal, 'Internal series assignment must not trigger external file import.');
    await page.screenshot({ path: path.join(output, 'internal-series-drag.png') });
    checks.push({ name: 'internal-series-drag', passed: true, internal, image });
    console.log('PASS internal-series-drag');
    assert.deepEqual(errors, [], 'Renderer emitted an uncaught error.');
    checks.push({ name: 'sandboxed-production-context', passed: true, preferences });
  } catch (error) {
    failure = error;
    if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  } finally {
    if (!await closeDesktop(desktop)) failure ??= new Error('The desktop app did not quit, so it was killed.');
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await fs.writeFile(path.join(output, 'process.log'), logs.join(''));
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ passed: !failure, platform: process.platform, study, checks, errors, error: failure?.stack,
      method: 'Production Electron app. Real disk-backed File objects selected through the browser file input; DragEvents dispatched with those same File objects. This does not simulate physical desktop pointer dragging.', profileRemoved: true }, null, 2));
  }
  if (failure) throw failure;
  console.log(`Results: ${path.join(output, 'results.json')}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
