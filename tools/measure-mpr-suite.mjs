import {createServer} from 'vite';
import {spawn} from 'node:child_process';
const server=await createServer({server:{host:'127.0.0.1',port:0}});await server.listen();
const child=spawn(process.execPath,['tools/check-viewport.mjs'],{env:{...process.env,VEACOM_TEST_URL:new URL('tools/viewport-check.html',server.resolvedUrls.local[0]).href},stdio:'inherit'});
const code=await new Promise(resolve=>child.once('exit',resolve));await server.close();process.exit(code??1);
