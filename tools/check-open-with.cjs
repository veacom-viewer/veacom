// Desktop check for studies opened from outside the app, as the Explorer entries of the Windows installer open them
// ("Open with VEAcom" on a folder, a drive, a ZIP, a DICOMDIR or a DICOM file). VEAcom is started with one study.
// Each later launch must end at once and leave its work to the running window:
// - a launch that names another study: the window opens it beside the first;
// - a launch that names nothing: nothing is imported;
// - a launch that names a path that is not there: the window says so.
// A packaged or installed app (--app) is given the second study as a bare argument, as Windows passes a file for
// "Open with"; a source run takes only --study.
// usage: node tools/check-open-with.cjs --study FOLDER --second FOLDER [--output DIRECTORY] [--app PACKAGED_EXECUTABLE]
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
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
    console.log('Usage: node tools/check-open-with.cjs --study FOLDER --second FOLDER [--output DIRECTORY] [--app PACKAGED_EXECUTABLE]');
    process.exit(0);
  }
  const [flag, inline] = argument.split(/=(.*)/s);
  assert(['--study', '--second', '--output', '--app'].includes(flag), `Unknown argument: ${argument}`);
  options[flag.slice(2)] = inline ?? process.argv[++index];
  assert(options[flag.slice(2)], `Missing value for ${flag}`);
}
assert(options.study && options.second, 'Give two different synthetic studies: --study FOLDER --second FOLDER');
const study = path.resolve(options.study), second = path.resolve(options.second);
const output = path.resolve(options.output || 'test-results/open-with');
const executable = options.app ? path.resolve(options.app) : require('electron');
const appArguments = options.app ? [] : [repo];
const checks = [], errors = [], logs = [];

/** A later launch of the same app on the same user data: resolves with its exit code, which must come promptly. */
function launchAgain(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...appArguments, ...args], { env, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`A later launch (${args.join(' ') || 'no arguments'}) did not end within 30 s.`)); }, 30_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
}

async function main() {
  await fs.mkdir(output, { recursive: true });
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'veacom-open-with-'));
  let desktop, page, failure;
  try {
    const env = { ...process.env, VEACOM_USER_DATA: profile, VEACOM_TEST_MODE: '1' };
    delete env.VEACOM_DEV_URL;
    delete env.VEACOM_DEVTOOLS;
    const launch = async studyPath => {
      desktop = await electron.launch({ ...(options.app ? { executablePath: executable } : {}), args: [...appArguments, '--study', studyPath], env, timeout: 90_000 });
      desktop.process().stderr?.on('data', data => logs.push(data.toString()));
      page = await desktop.firstWindow();
      await ignoreOutsideInput(desktop);
      page.on('pageerror', error => errors.push(error.message));
    };
    await launch(study);
    const seriesIds = () => page.evaluate(() => window.__VEACOM_TEST__.state().series.map(item => item.id));
    const settled = () => page.waitForFunction(() => window.__VEACOM_TEST__?.state().series.length > 0 && window.__VEACOM_TEST__.state().pendingLoads === 0
      && document.querySelector('[data-testid="veacom-app"]')?.dataset.ready === 'true', undefined, { timeout: 120_000 });
    await settled();
    const first = await seriesIds();
    assert(first.length > 0, 'The first launch opens the study it names.');
    checks.push({ name: 'first-launch-opens-its-study', passed: true, series: first.length });
    console.log('PASS The first launch opens the study it names');

    // A later launch that names another study ends at once; the running window opens that study too.
    assert.equal(await launchAgain(options.app ? [second] : ['--study', second], env), 0, 'A later launch ends cleanly.');
    await page.waitForFunction(known => window.__VEACOM_TEST__.state().series.some(item => !known.includes(item.id)), first, { timeout: 120_000 });
    await settled();
    const both = await seriesIds();
    assert(first.every(id => both.includes(id)), 'The study that was open stays open.');
    assert(both.length > first.length, 'The running window holds the series of both studies.');
    assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(window => !window.isDestroyed()).length), 1, 'No second window opens.');
    checks.push({ name: 'later-launch-opens-in-the-running-window', passed: true, series: both.length, bareArgument: Boolean(options.app) });
    console.log('PASS A later launch hands its study to the running window');

    // A later launch that names nothing only brings the window forward.
    const seriesBefore = await page.evaluate(() => window.__VEACOM_TEST__.state().series.length);
    assert.equal(await launchAgain([], env), 0, 'A later launch without a study ends cleanly.');
    await page.waitForTimeout(1500);
    assert.equal(await page.evaluate(() => window.__VEACOM_TEST__.state().series.length), seriesBefore, 'A launch that names nothing imports nothing.');
    checks.push({ name: 'later-launch-without-a-study', passed: true });
    console.log('PASS A later launch without a study imports nothing');

    // A later launch that names a path that is not there: the window says so and keeps what it shows.
    assert.equal(await launchAgain(['--study', path.join(profile, 'no-such-study')], env), 0, 'A later launch with a missing path ends cleanly.');
    const refusal = page.locator('[data-testid="notice"][data-kind="error"]');
    await refusal.waitFor({ timeout: 30_000 });
    const said = await refusal.textContent();
    assert(said.includes('no-such-study') && !/ENOENT|realpath/i.test(said), `The window names the path in plain words: ${said}`);
    assert.equal(await page.evaluate(() => window.__VEACOM_TEST__.state().series.length), seriesBefore, 'A missing path changes nothing that is open.');
    checks.push({ name: 'later-launch-with-a-missing-path', passed: true, said });
    console.log('PASS A later launch with a missing path is reported and changes nothing');

    await page.screenshot({ path: path.join(output, 'opened.png') });
    assert(await closeDesktop(desktop), 'The first viewer quit cleanly.');
    await launch(path.join(profile, 'missing-at-startup'));
    await page.locator('[data-testid="notice"][data-kind="error"]').filter({ hasText: 'missing-at-startup' }).waitFor();
    await page.locator('[data-testid="veacom-app"][data-ready="true"]').waitFor();
    assert.equal(await page.locator('[data-action="reconnect"]').count(), 0);
    checks.push({ name: 'missing-startup-path-leaves-viewer-ready', passed: true });
    console.log('PASS A missing startup path shows a file error and leaves the viewer ready');
    assert.deepEqual(errors, [], 'Renderer emitted an uncaught error.');
  } catch (error) {
    failure = error;
    if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  } finally {
    if (!await closeDesktop(desktop)) failure ??= new Error('The desktop app did not quit, so it was killed.');
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await fs.writeFile(path.join(output, 'process.log'), logs.join(''));
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ passed: !failure, platform: process.platform, packaged: Boolean(options.app), checks, errors, error: failure?.stack }, null, 2));
  }
  if (failure) throw failure;
  console.log(`All ${checks.length} open-with checks passed.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
