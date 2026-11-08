import { readFile, writeFile } from 'node:fs/promises';
import { comparePng } from './lib/png-diff.cjs';

const [expected, actual, output] = process.argv.slice(2);
if (!expected || !actual) throw new Error('Usage: node tools/diff-png.mjs <expected.png> <actual.png> [diff.png]');
const { result, diff } = comparePng(await readFile(expected), await readFile(actual));
if (output && diff) await writeFile(output, diff);
console.log(JSON.stringify(result));
if (!result.passed) process.exitCode = 1;
