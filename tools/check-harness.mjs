// Runs the viewport harness checks in sequence against tools/viewport-check.html: rendering and interaction
// (check-viewport), gestures cancelled by context changes (check-gestures), measurements against a stale or hidden
// screen (check-measurement-races) and panel state (check-panel-sessions). Serves the page with Vite unless
// VEACOM_TEST_URL names one. Linux CI runs it in VEAcom's Electron on llvmpipe (VEACOM_HARNESS_ELECTRON=1).
// Each check's output shows as it runs; one that takes longer than VEACOM_HARNESS_TIMEOUT_S (default 240) is stopped,
// so a stuck check fails the run instead of holding it. A failed check is not run again: these checks look for races,
// and a race that shows only sometimes is still a race.
import { spawn } from 'node:child_process';
import { createServer } from 'vite';

const limit = Number(process.env.VEACOM_HARNESS_TIMEOUT_S ?? 240) * 1000;
function run(check, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [check], { env, stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '', timedOut = false;
    child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk); });
    // Not SIGTERM: Playwright takes it to close its browser but leaves the check running. Interrupted, the check closes
    // the browser or Electron it started and exits, and a second interrupt does so at once.
    const stops = [[limit, 'SIGINT'], [limit + 5000, 'SIGINT'], [limit + 10000, 'SIGKILL']].map(([delay, signal]) =>
      setTimeout(() => { timedOut = true; child.kill(signal); }, delay));
    const stopped = () => stops.forEach(clearTimeout);
    child.on('error', error => { stopped(); reject(error); });
    child.on('exit', code => {
      stopped();
      if (timedOut) reject(new Error(`${check} did not finish within ${limit / 1000} s`));
      else if (code !== 0) reject(new Error(`${check} failed`));
      else resolve(output);
    });
  });
}

const given = process.env.VEACOM_TEST_URL;
const server = given ? null : await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false } });
let failure = null;
try {
  if (server) await server.listen();
  const url = given ?? new URL('tools/viewport-check.html', server.resolvedUrls.local[0]).href;
  for (const check of ['tools/check-viewport.mjs', 'tools/check-gestures.mjs', 'tools/check-measurement-races.mjs', 'tools/check-panel-sessions.mjs']) {
    console.log(`RUN ${check}`);
    const output = await run(check, { ...process.env, VEACOM_TEST_URL: url });
    console.log(`PASS ${check}: ${/"(?:count|checks)":\s*(\d+)/.exec(output)?.[1] ?? '?'} checks`);
  }
} catch (error) { failure = error; }
// Closing the server must not hold the run either.
await Promise.race([server?.close(), new Promise(resolve => setTimeout(resolve, 5000).unref())]);
if (failure) { console.error(failure.message); process.exit(1); }
process.exit(0);
