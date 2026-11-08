const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');

function prepareCounter(output) {
  if (process.platform !== 'linux' && process.platform !== 'darwin') return { reason: 'work counts need Linux or macOS' };
  const library = path.join(output, process.platform === 'darwin' ? 'io-count.dylib' : 'io-count.so');
  const source = path.join(__dirname, 'io-count.c');
  try {
    execFileSync('cc', process.platform === 'darwin' ? ['-O2', '-dynamiclib', '-o', library, source] : ['-O2', '-shared', '-fPIC', '-o', library, source, '-ldl'], { stdio: 'pipe' });
  } catch (error) {
    return { required: true, reason: `the read counter did not compile: ${String(error.stderr || error.message).trim().split('\n')[0]}` };
  }
  return { library, variable: process.platform === 'darwin' ? 'DYLD_INSERT_LIBRARIES' : 'LD_PRELOAD' };
}

async function readCounts(pid, file, after) {
  process.kill(pid, 'SIGUSR1');
  for (let waited = 0; waited < 3000; waited += 10) {
    await sleep(10);
    let record;
    try { record = fs.readFileSync(file); } catch { continue; }
    if (record.length < 32) continue;
    const [sequence, opened, calls, bytes] = [0, 8, 16, 24].map(offset => Number(record.readBigUInt64LE(offset)));
    if (sequence > after) return { sequence, opened, calls, bytes };
  }
  throw new Error('The read counter did not answer: the engine may not have loaded tools/lib/io-count.c');
}

module.exports = { prepareCounter, readCounts };
