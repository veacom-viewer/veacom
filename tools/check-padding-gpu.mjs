import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { createServer } from 'vite';

const [destination, expectedAdapter] = process.argv.slice(2);
if (!destination || !['t4', 'warp', 'mac', 'llvmpipe'].includes(expectedAdapter)) {
  throw new Error('Usage: node tools/check-padding-gpu.mjs <output-directory> <t4|warp|mac|llvmpipe>');
}
const output = path.resolve(destination);
await mkdir(output, { recursive: true });
const adapters = { t4: /\bNVIDIA\b.*\bT4\b/i, warp: /Microsoft Basic Render Driver|\bWARP\b/i, mac: /Apple (M\d+|GPU)/i, llvmpipe: /\bllvmpipe\b/i };
const expectations = new Map([['MONOCHROME1 padding stays black', [0, 0, 0, 255]]]);
for (const type of ['float32', 'float64']) {
  expectations.set(`${type}: scaled padding region 3,3`, [128, 128, 128, 255]);
  expectations.set(`${type}: finite interpolation weights are renormalized`, [38, 38, 38, 255]);
}
const summary = { passed: false, expectedAdapter, variants: [] };
const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false } });
try {
  await server.listen();
  for (const variant of ['parallel', 'fallback']) {
    const run = path.join(output, variant);
    const url = new URL(`tools/renderer-check.html${variant === 'fallback' ? '?no-parallel' : ''}`, server.resolvedUrls.local[0]);
    try {
      const { stdout } = await promisify(execFile)(process.execPath, ['tools/check-renderer-suite.cjs', run],
        { env: { ...process.env, VEACOM_TEST_URL: url.href }, timeout: 180000 });
      process.stdout.write(stdout);
    } catch (error) {
      if (error.stdout) process.stdout.write(error.stdout);
      if (error.stderr) process.stderr.write(error.stderr);
      throw error;
    }
    const result = JSON.parse(await readFile(path.join(run, 'renderer-suite.json'), 'utf8'));
    const renderer = result.renderer?.renderer ?? '';
    assert(result.passed && result.checks > 0, 'The full renderer suite must pass');
    assert(adapters[expectedAdapter].test(renderer), `Expected ${expectedAdapter}, got ${renderer}`);
    const cases = [];
    for (const [name, expected] of expectations) {
      const matches = result.results.filter(row => row.name === name);
      assert.equal(matches.length, 1, `Missing or duplicate pixel check: ${name}`);
      const [row] = matches;
      assert(row.passed && row.glError === 0, name);
      assert.deepEqual(row.expected, expected, name);
      assert.deepEqual(row.actual, expected, name);
      cases.push({ name, expected, actual: row.actual });
    }
    summary.variants.push({ variant, renderer, checks: result.checks, cases });
  }
  summary.passed = true;
} catch (error) {
  summary.error = String(error.stack || error); throw error;
} finally {
  await writeFile(path.join(output, 'padding-gpu.json'), JSON.stringify(summary, null, 2) + '\n');
  await server.close();
}
