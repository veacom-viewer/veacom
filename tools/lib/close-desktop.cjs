// A tool that opens the desktop app closes it here. Playwright's `close()` asks the app to quit and then waits for its
// process to end with no time limit: an app that cannot quit, such as one that never finished starting, would keep the
// check, and every step of tools/verify.sh after it, waiting until someone stopped it.
const { spawnSync } = require('node:child_process');

// Longer than the app's own shutdown (electron/main.cjs, will-quit): the engine's stop (engine-process.cjs, 1.5 + 5 + 1 s)
// and the usage flush.
const QUIT_MS = 20_000;

/** `promise`'s value, or false once `ms` have passed. */
async function within(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, ms, false); })]); }
  finally { clearTimeout(timer); }
}

const running = child => child.exitCode === null && child.signalCode === null;
/** Resolves once `child` has ended, at once if it already has; never rejects, unlike events.once on an 'error'. */
const ended = child => new Promise(resolve => { if (running(child)) child.once('exit', resolve); else resolve(); });

/** Kills `child` and every process it started (Electron's helpers and the imaging engine); resolves once it has ended. */
function killTree(child) {
  const gone = ended(child);
  // Playwright starts the app as the leader of a process group of its own, except on Windows, where Playwright too
  // stops the whole tree with taskkill. taskkill can stall itself, so it is stopped after 5 s.
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 });
  else try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  return gone;
}

/**
 * Closes the app a check launched. One whose process has not ended within `ms` is killed with its helpers and engine,
 * and the check is marked failed (`process.exitCode`). It never throws: called in `finally`, an error here would replace
 * the one that explains the failure, such as `firstWindow()` timing out.
 * @param desktop Playwright's ElectronApplication, or nothing when the launch itself failed
 * @returns whether the app quit by itself
 */
async function closeDesktop(desktop, ms = QUIT_MS) {
  if (!desktop) return true;
  const child = desktop.process();
  // close() also fails once the app has gone, so whether its process has ended decides.
  const closed = Promise.all([desktop.close().catch(() => {}), ended(child)]).then(() => true);
  if (await within(closed, ms) || !running(child)) return true;
  process.exitCode = 1;
  console.error(`The desktop app did not quit within ${ms / 1000} s, so it was killed with its helpers and engine.`);
  await within(killTree(child), 5000);
  return false;
}

module.exports = { closeDesktop };
