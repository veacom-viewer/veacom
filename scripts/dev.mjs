import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

// Puts the Electron runtime in place if a fresh install or an Electron update removed it; otherwise it only checks.
execFileSync(process.execPath, [fileURLToPath(new URL('setup-runtime.cjs', import.meta.url))], { stdio: 'inherit' });
const { default: electronPath } = await import('electron');
const server = await createServer();
await server.listen();
const electron = spawn(electronPath, ['.'], { stdio: 'inherit', env: { ...process.env, VEACOM_DEV_URL: 'http://127.0.0.1:5173' } });
electron.on('exit', async code => { await server.close(); process.exitCode = code ?? 1; });
process.on('SIGINT', () => electron.kill());
